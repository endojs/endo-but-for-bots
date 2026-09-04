// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeWorkflowService } from '../src/service.js';
import { foldJournal } from '../src/journal.js';
import {
  makeFakeAgent,
  makeFakeClock,
  makeRecordingTarget,
  settle,
} from './fake-agent.js';

const makeIdCounter = prefix => {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
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

const makeHarness = async () => {
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const first = await makeWorkflowService({
    powers,
    clock,
    makeId: makeIdCounter('a'),
  });
  return { controls, clock, ...first };
};

// Simulate a daemon restart: stop the old service, sever the fake
// daemon's live subscriptions and request promises, and build a fresh
// service over the same durable state.
const restart = async ({ controls, clock }, generation = 'b') => {
  const powers = controls.restart();
  const next = await makeWorkflowService({
    powers,
    clock,
    makeId: makeIdCounter(generation),
  });
  return { controls, clock, ...next };
};

test('pending invokes re-dispatch under the same effectId', async t => {
  const h1 = await makeHarness();
  /** @type {{ args: any[], effectId: string }[]} */
  const calls = [];
  // The first incarnation's target never answers; the second answers.
  let respond = false;
  const chart = harden({
    name: 'retry',
    version: 1,
    initial: 'call',
    states: {
      call: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            args: ['job'],
            outcome: 'done-call',
          },
        ],
        on: { 'done-call': [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  // A target whose settlement never arrives in incarnation one.
  const { Far } = await import('@endo/pass-style');
  const flaky = Far('Flaky', {
    perform: async (...allArgs) => {
      calls.push({ args: allArgs.slice(0, -1), effectId: allArgs.at(-1) });
      if (!respond) {
        return new Promise(() => {});
      }
      return 'finally';
    },
  });
  const { runId } = await E(h1.service).start(chart, {
    endowments: harden({ worker: flaky }),
  });
  await until(() => calls.length === 1, 'first dispatch');
  t.false(h1.engines.get(runId).fold.done);
  h1.stop();

  respond = true;
  const h2 = await restart(h1);
  const engine = h2.engines.get(runId);
  t.truthy(engine);
  await until(() => engine.fold.done, 'run completion after restart');
  t.is(engine.fold.outcome, 'completed');
  // Re-dispatched exactly once more, with the same idempotency key.
  t.is(calls.length, 2);
  t.is(calls[0].effectId, calls[1].effectId);
  // The journal shows both dispatches: an honest at-least-once record.
  const journal = await E(engine.runFacet).journal();
  const dispatches = journal.filter(
    entry => entry.kind === 'effect-dispatched',
  );
  t.is(dispatches.length, 2);
});

const askChart = harden({
  name: 'asker',
  version: 1,
  initial: 'asking',
  states: {
    asking: {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          what: { description: 'Approve?' },
          outcome: 'answered',
        },
      ],
      on: {
        answered: [{ target: 'ok', assign: { answer: { $event: 'value' } } }],
      },
    },
    ok: { final: true, output: { answer: { $ctx: 'answer' } } },
  },
});

test('an ask answered while the daemon was down is adopted on recovery', async t => {
  const h1 = await makeHarness();
  const { runId } = await E(h1.service).start(askChart, {
    endowments: harden({ operator: harden({}) }),
  });
  await until(
    () =>
      h1.controls.findMessage('request', `[workflow ${runId}`) !== undefined,
    'request sent',
  );
  h1.stop();
  const message = h1.controls.findMessage('request', `[workflow ${runId}`);

  // The daemon is "down"; the durable resolver still commits the answer.
  h1.controls.restart();
  await h1.controls.resolveRequest(message, 'yes, while you were away');

  const h2 = await makeWorkflowService({
    powers: h1.controls.restart(),
    clock: h1.clock,
    makeId: makeIdCounter('b'),
  });
  const engine = h2.engines.get(runId);
  await until(() => engine.fold.done, 'answer adopted');
  t.deepEqual(engine.fold.output, { answer: 'yes, while you were away' });
  // No duplicate ask was ever sent.
  t.is(h1.controls.messageCount('request', `[workflow ${runId}`), 1);
});

test('an unanswered ask survives restart without re-sending', async t => {
  const h1 = await makeHarness();
  const { runId } = await E(h1.service).start(askChart, {
    endowments: harden({ operator: harden({}) }),
  });
  await until(
    () =>
      h1.controls.findMessage('request', `[workflow ${runId}`) !== undefined,
    'request sent',
  );
  h1.stop();

  const h2 = await restart(h1);
  await settle();
  t.is(h2.controls.messageCount('request', `[workflow ${runId}`), 1);
  const engine = h2.engines.get(runId);
  t.false(engine.fold.done);
  const status = await E(engine.runFacet).status();
  t.is(status.prompts.length, 1);

  // A late answer still settles through the re-attached listener.
  const message = h2.controls.findMessage('request', `[workflow ${runId}`);
  await h2.controls.resolveRequest(message, 'late but durable');
  await until(() => engine.fold.done, 'late answer settled');
  t.deepEqual(engine.fold.output, { answer: 'late but durable' });
});

test('a form reply that arrived while down settles on recovery', async t => {
  const h1 = await makeHarness();
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
              fields: [{ name: 'approved', label: 'Approve?' }],
            },
            outcome: 'submitted',
          },
        ],
        on: {
          submitted: [
            { target: 'ok', assign: { values: { $event: 'value' } } },
          ],
        },
      },
      ok: { final: true, output: { values: { $ctx: 'values' } } },
    },
  });
  const { runId } = await E(h1.service).start(chart, {
    endowments: harden({ operator: harden({}) }),
  });
  await until(
    () => h1.controls.findMessage('form', `[workflow ${runId}`) !== undefined,
    'form sent',
  );
  h1.stop();
  const form = h1.controls.findMessage('form', `[workflow ${runId}`);
  h1.controls.restart();
  await h1.controls.submitForm(form, { approved: true });

  const h2 = await makeWorkflowService({
    powers: h1.controls.restart(),
    clock: h1.clock,
    makeId: makeIdCounter('b'),
  });
  const engine = h2.engines.get(runId);
  await until(() => engine.fold.done, 'reply adopted');
  t.deepEqual(engine.fold.output, { values: { approved: true } });
});

test('after deadlines re-arm from journaled absolute times', async t => {
  const h1 = await makeHarness();
  const chart = harden({
    name: 'deadline',
    version: 1,
    initial: 'wait',
    states: {
      wait: {
        entry: [{ kind: 'after', ms: 5000, emit: { type: 'expired' } }],
        on: { expired: [{ target: 'late' }] },
      },
      late: { final: true },
    },
  });
  const { runId } = await E(h1.service).start(chart, {});
  await settle();
  await h1.clock.advance(1000);
  h1.stop();

  const h2 = await restart(h1);
  const engine = h2.engines.get(runId);
  await settle();
  t.false(engine.fold.done);
  // Not yet due: 1s of the 5s elapsed before the restart.
  await h2.clock.advance(3500);
  await settle();
  t.false(engine.fold.done);
  // The journaled absolute deadline, not a restarted countdown, governs.
  await h2.clock.advance(600);
  await until(() => engine.fold.done, 'deadline fired after restart');
  t.is(engine.fold.configuration.state, 'late');
});

test('a deadline that passed while down fires immediately on recovery', async t => {
  const h1 = await makeHarness();
  const chart = harden({
    name: 'overdue',
    version: 1,
    initial: 'wait',
    states: {
      wait: {
        entry: [{ kind: 'after', ms: 5000, emit: { type: 'expired' } }],
        on: { expired: [{ target: 'late' }] },
      },
      late: { final: true },
    },
  });
  const { runId } = await E(h1.service).start(chart, {});
  await settle();
  h1.stop();
  await h1.clock.advance(60_000);

  const h2 = await restart(h1);
  const engine = h2.engines.get(runId);
  await h2.clock.advance(1);
  await until(() => engine.fold.done, 'overdue deadline fired');
  t.is(engine.fold.configuration.state, 'late');
});

test('paused runs keep their queued events across restart', async t => {
  const h1 = await makeHarness();
  const chart = harden({
    name: 'pausable',
    version: 1,
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b' }] } },
      b: { final: true },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  await E(control).pause();
  await E(control).signal(harden({ type: 'go' }));
  await settle();
  h1.stop();

  const h2 = await restart(h1);
  const engine = h2.engines.get(runId);
  t.true(engine.fold.paused);
  t.is(engine.fold.queuedEvents.size, 1);
  t.false(engine.fold.done);
  const control2 = await E(h2.service).control(runId);
  await E(control2).resume();
  await until(() => engine.fold.done, 'queued event applied after resume');
  t.is(engine.fold.configuration.state, 'b');
});

test('parent-child spawn links re-derive across restart', async t => {
  const h1 = await makeHarness();
  const childChart = harden({
    name: 'child',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: { on: { finish: [{ target: 'ok' }] } },
      ok: { final: true, output: { done: true } },
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
            params: {},
            outcome: 'child-done',
          },
        ],
        on: {
          'child-done': [
            { target: 'ok', assign: { child: { $event: 'value.output' } } },
          ],
        },
      },
      ok: { final: true, output: { child: { $ctx: 'child' } } },
    },
  });
  const { runId } = await E(h1.service).start(chart, {});
  const parent1 = h1.engines.get(runId);
  await until(
    () =>
      [...parent1.fold.pending.values()].some(
        record => record.childRunId !== undefined,
      ),
    'child spawned',
  );
  const { childRunId } = [...parent1.fold.pending.values()].find(
    record => record.childRunId !== undefined,
  );
  h1.stop();

  const h2 = await restart(h1);
  const parent = h2.engines.get(runId);
  const child = h2.engines.get(childRunId);
  t.truthy(child);
  t.false(parent.fold.done);
  const childControl = await E(h2.service).control(childRunId);
  await E(childControl).signal(harden({ type: 'finish' }));
  await until(() => parent.fold.done, 'parent settled by recovered child');
  t.deepEqual(parent.fold.output, { child: { done: true } });
});

test('terminal runs recover read-only and the fold matches the journal', async t => {
  const h1 = await makeHarness();
  const { target } = makeRecordingTarget(['fine']);
  const chart = harden({
    name: 'oneshot',
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
          },
        ],
        on: {
          'done-call': [{ target: 'ok', assign: { got: { $event: 'value' } } }],
        },
      },
      ok: { final: true, output: { got: { $ctx: 'got' } } },
    },
  });
  const { runId } = await E(h1.service).start(chart, {
    endowments: harden({ worker: target }),
  });
  const engine1 = h1.engines.get(runId);
  await until(() => engine1.fold.done, 'run completion');
  h1.stop();

  const h2 = await restart(h1);
  const engine = h2.engines.get(runId);
  t.true(engine.fold.done);
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { got: 'fine' });

  // Replay determinism: an independent fold of the stored journal agrees
  // with the recovered live state on every axis.
  const journal = await E(engine.runFacet).journal();
  const folded = foldJournal(journal);
  t.deepEqual(folded.configuration, engine.fold.configuration);
  t.deepEqual(folded.context, engine.fold.context);
  t.is(folded.done, engine.fold.done);
  t.is(folded.outcome, engine.fold.outcome);
  t.deepEqual(folded.output, engine.fold.output);
  t.is(folded.pending.size, engine.fold.pending.size);
  t.is(folded.nextSeq, engine.fold.nextSeq);

  // The summary listing includes the recovered terminal run.
  const summaries = await E(h2.service).list();
  t.is(summaries.length, 1);
  t.is(summaries[0].outcome, 'completed');
});
