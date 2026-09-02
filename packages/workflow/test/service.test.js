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
    { method: 'perform', args: ['payload'], effectId: `${runId}:0-0` },
  ]);
  const status = await E(run).status();
  t.is(status.outcome, 'completed');
  t.deepEqual(status.output, { got: 'answer-1' });
  // The journal is durable and self-describing.
  const journal = await E(run).journal();
  t.deepEqual(
    journal.map(entry => entry.kind),
    ['started', 'effect-dispatched', 'event'],
  );
  // The settlement, its transition, and the terminal outcome commit as
  // ONE atomic entry — no crash can separate them.
  const settlementEntry = journal[2];
  t.is(settlementEntry.by, 'invoke:worker');
  t.is(settlementEntry.settles.effectId, '0-0');
  t.is(settlementEntry.settles.status, 'fulfilled');
  t.truthy(settlementEntry.fired);
  t.is(settlementEntry.terminal.outcome, 'completed');
});

test('runs sharing an endowment hand it distinct idempotency keys', async t => {
  // Effect ids are `${seq}-${index}`, unique within one run only, so two
  // runs' first invokes both journal as '0-0'. The key on the wire must
  // still tell them apart: a target deduping on it (the invoke contract)
  // would otherwise swallow the second run's effect as a duplicate of
  // the first.
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target, calls } = makeRecordingTarget(['answer-1', 'answer-2']);
  const chart = harden({
    name: 'shared-invoker',
    version: 1,
    initial: 'call',
    states: {
      call: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            args: [],
            outcome: 'done-call',
            failure: 'failed-call',
          },
        ],
        on: {
          'done-call': [{ target: 'ok' }],
          'failed-call': [{ target: 'sad' }],
        },
      },
      ok: { final: true },
      sad: { final: true },
    },
  });
  const endowments = harden({ worker: target });
  const { runId: runA } = await E(service).start(chart, { endowments });
  const { runId: runB } = await E(service).start(chart, { endowments });
  await until(
    () => engines.get(runA).fold.done && engines.get(runB).fold.done,
    'both runs complete',
  );
  const keys = calls.map(call => call.effectId);
  t.deepEqual([...new Set(keys)].sort(), [...keys].sort());
  t.deepEqual(keys.sort(), [`${runA}:0-0`, `${runB}:0-0`].sort());
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
  // Compensation invokes honor the run-qualified key contract too: a
  // shared endowment deduping on the trailing key must never conflate
  // different runs' cancels (or two compensations of one cancel) under a
  // constant. The index is deterministic, so a re-issued cancel after a
  // crash re-derives the same key.
  t.is(calls[0].effectId, `${runId}:cancel:0`);
  const journal = await E(engine.runFacet).journal();
  const cancellationEntries = journal.filter(
    entry => entry.event?.type === 'cancel-requested',
  );
  t.is(cancellationEntries.length, 1);
  t.is(
    cancellationEntries[0].kind,
    'cancelled',
    'an unhandled request and its terminal cancellation are one write',
  );
});

test('handled cancellation waits for a child reconciliation workflow', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target, calls } = makeRecordingTarget(['clean']);
  const childChart = harden({
    name: 'reconciling-child',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        on: { 'cancel-requested': [{ target: 'cleaning' }] },
      },
      cleaning: {
        entry: [
          {
            kind: 'invoke',
            target: 'janitor',
            method: 'perform',
            args: ['restore'],
            outcome: 'cleaned',
          },
        ],
        on: {
          cleaned: [{ target: 'stopped' }],
          'cancel-requested': [{}],
        },
      },
      stopped: { final: true, output: { status: 'reconciled' } },
    },
  });
  const chart = harden({
    name: 'reconciling-parent',
    version: 1,
    initial: 'working',
    states: {
      working: {
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: {},
            endowments: ['janitor'],
            outcome: 'child-done',
          },
        ],
        on: {
          'child-done': [{ target: 'stopped' }],
          'cancel-requested': [{}],
        },
      },
      stopped: { final: true, output: { status: 'reconciled' } },
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

  await E(control).pause();
  await E(control).signal(harden({ type: 'queued-before-cancel' }));
  await until(() => engine.fold.queuedEvents.size === 1, 'event queued');
  await E(control).cancel('operator changed their mind');
  await until(() => engine.fold.done, 'parent reconciled');
  await until(() => child.fold.done, 'child reconciled');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { status: 'reconciled' });
  t.is(child.fold.outcome, 'completed');
  t.deepEqual(child.fold.output, { status: 'reconciled' });
  t.is(engine.fold.queuedEvents.size, 0);
  t.is(calls.length, 1);
  t.deepEqual(calls[0].args, ['restore']);
});

test('paused cancellation replays an already-settled child outcome', async t => {
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const childChart = harden({
    name: 'settling-child',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: { on: { finish: [{ target: 'done' }] } },
      done: { final: true, output: { status: 'finished' } },
    },
  });
  const chart = harden({
    name: 'waiting-parent',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: {},
            outcome: 'child-done',
          },
        ],
        on: {
          'child-done': [{ target: 'done' }],
          'cancel-requested': [{}],
        },
      },
      done: { final: true, output: { status: 'child-settled' } },
    },
  });
  const { runId, control } = await E(service).start(chart, {});
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

  await E(control).pause();
  await E(childControl).signal(harden({ type: 'finish' }));
  await until(
    () => engine.fold.queuedEvents.size === 1,
    'child outcome queued in parent',
  );
  t.is(engine.fold.pending.size, 0, 'the settled spawn is no longer pending');

  await E(control).cancel('after child settlement');
  await until(() => engine.fold.done, 'queued child outcome replayed');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { status: 'child-settled' });
});

test('paused cancellation drops a settlement routed to the exited state', async t => {
  const { controls, service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const { target, calls } = makeRecordingTarget(['restored']);
  const chart = harden({
    name: 'cancel-stale-settlement',
    version: 1,
    initial: 'approval',
    states: {
      approval: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            what: { description: 'approve?' },
            outcome: 'decided',
          },
        ],
        on: {
          decided: [{ target: 'unsafe' }],
          'cancel-requested': [{ target: 'cleaning' }],
        },
      },
      cleaning: {
        entry: [
          {
            kind: 'invoke',
            target: 'janitor',
            method: 'perform',
            args: ['restore'],
            outcome: 'cleaned',
          },
        ],
        on: {
          cleaned: [{ target: 'safe' }],
          'cancel-requested': [{}],
        },
      },
      unsafe: { final: true },
      safe: { final: true, output: { status: 'restored' } },
    },
  });
  const { runId, control } = await E(service).start(chart, {
    endowments: harden({ operator: harden({}), janitor: target }),
  });
  const engine = engines.get(runId);
  await until(
    () => controls.findMessage('request', `[workflow ${runId}`) !== undefined,
    'approval sent',
  );
  await E(control).pause();
  await controls.resolveRequest(
    controls.findMessage('request', `[workflow ${runId}`),
    'approved before cancellation',
  );
  await until(() => engine.fold.queuedEvents.size === 1, 'approval queued');

  await E(control).cancel('withdrawn');
  await until(() => engine.fold.done, 'cleanup completed');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { status: 'restored' });
  t.is(calls.length, 1);
  const journal = await E(engine.runFacet).journal();
  const replay = journal.find(entry => entry.replays !== undefined);
  t.true(replay.stale);
  t.is(replay.terminal, undefined);
});

test('the service start facet ignores a caller-supplied runId', async t => {
  // `runId` is the internal spawn path's parameter. A caller-chosen id
  // could clobber an existing run's store and mint duplicate
  // `${runId}:${effectId}` keys for two distinct runs.
  const { service, engines, stop } = await makeHarness();
  t.teardown(stop);
  const chart = harden({
    name: 'plain',
    version: 1,
    initial: 'done',
    states: { done: { final: true } },
  });
  // The literal deliberately smuggles the internal `runId` parameter;
  // the cast keeps the excess-property check from rejecting what the
  // runtime must be shown to drop.
  const options = /** @type {any} */ (
    harden({ params: harden({}), runId: 'r-chosen' })
  );
  const { runId } = await E(service).start(chart, options);
  t.not(runId, 'r-chosen');
  t.true(engines.has(runId));
  t.false(engines.has('r-chosen'));
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
    for await (const entry of /** @type {AsyncIterable<any>} */ (
      iterateReader(reader)
    )) {
      seen.push(`${entry.seq}:${entry.kind}`);
    }
  })();
  await until(() => seen.length >= 1, 'replay arrived');
  await E(control).signal(harden({ type: 'go' }));
  await until(() => engine.fold.done, 'run completion');
  await consumed;
  // The terminal outcome rides the final event entry.
  t.deepEqual(seen, ['1:event', '2:event']);
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
