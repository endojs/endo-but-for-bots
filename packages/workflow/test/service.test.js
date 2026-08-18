// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeWorkflowService } from '../src/service.js';
import {
  makeFakeAgent,
  makeFakeClock,
  makeRecordingTarget,
  settle,
} from './fake-agent.js';

const makeIdCounter = () => {
  let n = 0;
  return () => {
    n += 1;
    return `id${n}`;
  };
};

const makeHarness = async () => {
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const { service, stop, engines, startRun } = await makeWorkflowService({
    powers,
    clock,
    makeId: makeIdCounter(),
  });
  return { powers, controls, clock, service, stop, engines, startRun };
};

// Poll until `fn` is truthy, letting eventual-send cascades settle.
const until = async (fn, label = 'condition', tries = 400) => {
  await null;
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  throw Error(`timed out waiting for ${label}`);
};

test('start journals, invokes with effectId, and completes on the outcome', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target, calls } = makeRecordingTarget(['answer-1']);
  const chart = harden({
    name: 'invoker',
    version: 1,
    params: M.splitRecord({ x: M.string() }),
    initial: 'call',
    states: {
      call: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            args: [{ $params: 'x' }],
            outcome: 'done-call',
            failure: 'failed-call',
          },
        ],
        on: {
          'done-call': [{ target: 'ok', assign: { got: { $event: 'value' } } }],
          'failed-call': [
            { target: 'sad', assign: { err: { $event: 'value.reason' } } },
          ],
        },
      },
      ok: { final: true, output: { got: { $ctx: 'got' } } },
      sad: { final: true },
    },
  });
  const { runId, run } = await E(service).start(chart, {
    params: harden({ x: 'payload' }),
    endowments: harden({ worker: target }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.deepEqual(calls, [
    { method: 'perform', args: ['payload'], effectId: '0-0' },
  ]);
  const status = await E(run).status();
  t.is(status.outcome, 'completed');
  t.deepEqual(status.output, { got: 'answer-1' });
  // The journal is durable and self-describing.
  const journal = await E(run).journal();
  t.deepEqual(
    journal.map(entry => entry.kind),
    ['started', 'effect-dispatched', 'effect-settled', 'event', 'completed'],
  );
  t.is(journal[3].by, 'invoke:worker');
});

test('invoke failures route to the declared failure event', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target } = makeRecordingTarget([Error('boom')]);
  const chart = harden({
    name: 'failer',
    version: 1,
    initial: 'call',
    states: {
      call: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            outcome: 'done-call',
            failure: 'failed-call',
          },
        ],
        on: {
          'done-call': [{ target: 'ok' }],
          'failed-call': [
            { target: 'sad', assign: { err: { $event: 'value.reason' } } },
          ],
        },
      },
      ok: { final: true },
      sad: { final: true, output: { err: { $ctx: 'err' } } },
    },
  });
  const { runId } = await E(service).start(chart, {
    endowments: harden({ worker: target }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.outcome, 'completed');
  t.is(engine.fold.output.err, 'boom');
});

test('emit chains internal events; after fires on the clock and re-arms exits', async t => {
  const { service, engines, clock, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'timers',
    version: 1,
    initial: 'wait',
    states: {
      wait: {
        entry: [
          { kind: 'emit', event: { type: 'poke' } },
          { kind: 'after', ms: 5000, emit: { type: 'expired' } },
        ],
        on: {
          poke: [{ assign: { poked: true } }],
          expired: [{ target: 'late' }],
          done: [{ target: 'ok' }],
        },
      },
      late: { final: true },
      ok: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await until(() => engine.fold.context.poked === true, 'emit applied');
  t.false(engine.fold.done);
  await clock.advance(5100);
  await until(() => engine.fold.done, 'deadline fired');
  t.is(engine.fold.configuration.state, 'late');
});

test('exiting a state cancels its pending after deadline', async t => {
  const { service, engines, clock, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'debounce',
    version: 1,
    initial: 'wait',
    states: {
      wait: {
        entry: [{ kind: 'after', ms: 5000, emit: { type: 'expired' } }],
        on: {
          expired: [{ target: 'late' }],
          done: [{ target: 'ok' }],
        },
      },
      late: { final: true },
      ok: { final: true },
    },
  });
  const { runId, control } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await E(control).signal(harden({ type: 'done' }));
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.configuration.state, 'ok');
  // The deadline was pruned with its state; advancing the clock changes
  // nothing.
  await clock.advance(10_000);
  await settle();
  t.is(engine.fold.configuration.state, 'ok');
  t.is(engine.fold.pending.size, 0);
});

const askChart = harden({
  name: 'asker',
  version: 1,
  params: M.splitRecord({ title: M.string() }),
  initial: 'asking',
  states: {
    asking: {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          what: { description: 'Approve {$params.title}?' },
          outcome: 'answered',
          failure: 'refused',
        },
      ],
      on: {
        answered: [{ target: 'ok', assign: { answer: { $event: 'value' } } }],
        refused: [{ target: 'sad' }],
      },
    },
    ok: { final: true, output: { answer: { $ctx: 'answer' } } },
    sad: { final: true },
  },
});

test('ask (request) sends durable mail and settles on resolution', async t => {
  const { controls, service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const operator = harden({});
  const { runId, run } = await E(service).start(askChart, {
    params: harden({ title: 'Adder' }),
    endowments: harden({ operator }),
  });
  const engine = engines.get(runId);
  await until(
    () => controls.findMessage('request', '[workflow') !== undefined,
    'request sent',
  );
  const message = controls.findMessage('request', `[workflow ${runId} 0-0]`);
  t.truthy(message);
  t.true(message.description.startsWith('Approve "Adder"?'));
  const status = await E(run).status();
  t.is(status.prompts.length, 1);
  t.is(status.prompts[0].to, 'operator');

  await controls.resolveRequest(message, 'ship it');
  await until(() => engine.fold.done, 'run completion');
  t.deepEqual(engine.fold.output, { answer: 'ship it' });
  // The answer also landed durably at the journaled responseName.
  const stored = controls.peek(['workflow', 'runs', runId, 'answers', '0-0']);
  t.is(stored, 'ship it');
});

test('ask (request) rejection routes to the failure event', async t => {
  const { controls, service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { runId } = await E(service).start(askChart, {
    params: harden({ title: 'Adder' }),
    endowments: harden({ operator: harden({}) }),
  });
  const engine = engines.get(runId);
  await until(
    () =>
      controls.findMessage('request', `[workflow ${runId} 0-0]`) !== undefined,
    'request sent',
  );
  await controls.rejectRequest(
    controls.findMessage('request', `[workflow ${runId} 0-0]`),
    'nope',
  );
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.configuration.state, 'sad');
});

test('ask (form) settles from the value reply', async t => {
  const { controls, service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'former',
    version: 1,
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            form: {
              description: 'Merge?',
              fields: [
                { name: 'approved', label: 'Approve?', pattern: M.boolean() },
              ],
            },
            outcome: 'submitted',
          },
        ],
        on: {
          submitted: [
            {
              when: M.splitRecord({
                value: M.splitRecord({ approved: M.eq(true) }),
              }),
              target: 'merged',
            },
            { target: 'abandoned' },
          ],
        },
      },
      merged: { final: true },
      abandoned: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {
    endowments: harden({ operator: harden({}) }),
  });
  const engine = engines.get(runId);
  await until(
    () => controls.findMessage('form', `[workflow ${runId} 0-0]`) !== undefined,
    'form sent',
  );
  await controls.submitForm(
    controls.findMessage('form', `[workflow ${runId} 0-0]`),
    { approved: true },
  );
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.configuration.state, 'merged');
});

test('ports pattern-check events and attribute them structurally', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'ported',
    version: 1,
    ports: {
      approver: M.splitRecord({ type: M.eq('approve') }),
    },
    initial: 'waiting',
    states: {
      waiting: { on: { approve: [{ target: 'ok' }] } },
      ok: { final: true },
    },
  });
  const { runId, run, control } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  const port = await E(control).port('approver');
  await t.throwsAsync(() => E(port).submit(harden({ type: 'reject' })), {
    message: /approver/,
  });
  await t.throwsAsync(() => E(control).port('missing'), {
    message: /declares no port/,
  });
  await E(port).submit(harden({ type: 'approve' }));
  await until(() => engine.fold.done, 'run completion');
  const journal = await E(run).journal();
  const eventEntry = journal.find(entry => entry.kind === 'event');
  t.is(eventEntry.by, 'port:approver');
});

test('pause queues events durably; resume replays them', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'pausable',
    version: 1,
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b' }] } },
      b: { final: true },
    },
  });
  const { runId, control } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await E(control).pause();
  await E(control).signal(harden({ type: 'go' }));
  await settle();
  t.false(engine.fold.done);
  t.is(engine.fold.configuration.state, 'a');
  t.is(engine.fold.queuedEvents.size, 1);
  await E(control).resume();
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.configuration.state, 'b');
});

test('cancel runs compensation invokes and cascades to children', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target, calls } = makeRecordingTarget();
  const childChart = harden({
    name: 'child',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: { on: { finish: [{ target: 'ok' }] } },
      ok: { final: true },
    },
  });
  const chart = harden({
    name: 'parent',
    version: 1,
    initial: 'working',
    states: {
      working: {
        exit: [
          {
            kind: 'invoke',
            target: 'janitor',
            method: 'perform',
            args: ['sweep'],
            outcome: 'swept',
          },
        ],
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: {},
            outcome: 'child-done',
          },
        ],
        on: { 'child-done': [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { runId, control } = await E(service).start(chart, {
    endowments: harden({ janitor: target }),
  });
  const engine = engines.get(runId);
  await until(
    () =>
      [...engine.fold.pending.values()].some(
        record => record.childRunId !== undefined,
      ),
    'child spawned',
  );
  const childRunId = [...engine.fold.pending.values()].find(
    record => record.childRunId !== undefined,
  ).childRunId;
  const child = engines.get(childRunId);
  t.false(child.fold.done);

  await E(control).cancel('operator changed their mind');
  await until(() => engine.fold.done, 'parent cancelled');
  t.is(engine.fold.outcome, 'cancelled');
  await until(() => child.fold.done, 'child cancelled');
  t.is(child.fold.outcome, 'cancelled');
  await until(() => calls.length === 1, 'compensation ran');
  t.deepEqual(calls[0].args, ['sweep']);
});

test('spawned children settle their parents with outputs', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const childChart = harden({
    name: 'child',
    version: 1,
    params: M.splitRecord({ item: M.string() }),
    initial: 'deciding',
    states: {
      deciding: {
        on: { verdict: [{ target: 'ok', assign: { v: { $event: 'value' } } }] },
      },
      ok: {
        final: true,
        output: { v: { $ctx: 'v' }, of: { $params: 'item' } },
      },
    },
  });
  const chart = harden({
    name: 'parent',
    version: 1,
    initial: 'delegating',
    states: {
      delegating: {
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: { item: 'thing' },
            outcome: 'child-done',
          },
        ],
        on: {
          'child-done': [
            { target: 'ok', assign: { result: { $event: 'value.output' } } },
          ],
        },
      },
      ok: { final: true, output: { result: { $ctx: 'result' } } },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await until(
    () =>
      [...engine.fold.pending.values()].some(
        record => record.childRunId !== undefined,
      ),
    'child spawned',
  );
  const childRunId = [...engine.fold.pending.values()].find(
    record => record.childRunId !== undefined,
  ).childRunId;
  const childControl = await E(service).control(childRunId);
  await E(childControl).signal(harden({ type: 'verdict', value: 'good' }));
  await until(() => engine.fold.done, 'parent completion');
  t.deepEqual(engine.fold.output, { result: { v: 'good', of: 'thing' } });
});

test('follow replays from a seq cursor then tails live entries', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'followed',
    version: 1,
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b' }] } },
      b: { on: { go: [{ target: 'c' }] } },
      c: { final: true },
    },
  });
  const { runId, run, control } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await E(control).signal(harden({ type: 'go' }));
  await settle();

  const seen = [];
  const reader = await E(run).follow({ since: 1n });
  const consumed = (async () => {
    for await (const entry of iterateReader(reader)) {
      seen.push(`${entry.seq}:${entry.kind}`);
    }
  })();
  await until(() => seen.length >= 1, 'replay arrived');
  await E(control).signal(harden({ type: 'go' }));
  await until(() => engine.fold.done, 'run completion');
  await consumed;
  t.deepEqual(seen, ['1:event', '2:event', '3:completed']);
});

test('service lists, installs, and starts charts by key with region refs', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const regionChart = harden({
    name: 'leaf',
    version: 1,
    initial: 'go',
    states: { go: { final: true } },
  });
  await E(service).install(regionChart);
  const parent = harden({
    name: 'composed',
    version: 1,
    initial: 'p',
    states: {
      p: {
        regions: ['leaf-v1', 'leaf-v1'],
        join: 'counts',
        on: {
          'regions-settled': [
            {
              when: M.splitRecord({
                counts: M.splitRecord({ pending: M.eq(0) }),
              }),
              target: 'done',
            },
          ],
        },
      },
      done: { final: true },
    },
  });
  const key = await E(service).install(parent);
  t.is(key, 'composed-v1');
  const installed = await E(service).charts();
  t.deepEqual(installed.map(chart => chart.key).sort(), [
    'composed-v1',
    'leaf-v1',
  ]);
  const { runId } = await E(service).start('composed-v1', {});
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.outcome, 'completed');
  const summaries = await E(service).list();
  t.is(summaries.length, 1);
  t.is(summaries[0].chartName, 'composed');
});
