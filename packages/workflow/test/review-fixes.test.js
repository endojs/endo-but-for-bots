// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { M } from '@endo/patterns';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  assertChart,
  chartDiagnostics,
  engineEventTypes,
} from '../src/machine.js';
import { verifyJournalChain } from '../src/journal.js';
import { makeWorkflowService } from '../src/service.js';
import { makeSimulator } from '../src/simulate.js';
import { makeRunSyncClient } from '../src/sync.js';
import { makeFakeAgent, makeFakeClock, settle } from './fake-agent.js';

const makeIdCounter = (prefix = 'id') => {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
};

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

/**
 * Wrap agent powers so `storeValue` throws when `shouldCrash` matches —
 * the write never lands, simulating a process death at that exact
 * durable boundary.
 *
 * @param {any} powers
 * @param {(value: any, path: any) => boolean} shouldCrash
 */
const crashingPowers = (powers, shouldCrash) =>
  harden({
    has: (...segments) => E(powers).has(...segments),
    list: (...segments) => E(powers).list(...segments),
    lookup: nameOrPath => E(powers).lookup(nameOrPath),
    maybeLookup: nameOrPath => E(powers).maybeLookup(nameOrPath),
    makeDirectory: nameOrPath => E(powers).makeDirectory(nameOrPath),
    storeValue: async (value, nameOrPath) => {
      if (shouldCrash(value, nameOrPath)) {
        throw Error('simulated crash before durable write');
      }
      return E(powers).storeValue(value, nameOrPath);
    },
    request: (...args) => E(powers).request(...args),
    form: (...args) => E(powers).form(...args),
    listMessages: () => E(powers).listMessages(),
    followMessages: () => E(powers).followMessages(),
  });

// #region kernel findings

test('an immediately-final compound child raises state-done at entry', t => {
  const chart = harden({
    name: 'instant-compound',
    version: 1,
    initial: 'work',
    states: {
      work: {
        initial: 'fin',
        states: { fin: { final: true, output: { done: 'yes' } } },
        on: {
          'state-done': [
            { target: 'wrap', assign: { got: { $event: 'value.output' } } },
          ],
        },
      },
      wrap: { final: true, output: { got: { $ctx: 'got' } } },
    },
  });
  const sim = makeSimulator(chart);
  t.true(sim.status().done);
  t.is(sim.status().outcome, 'completed');
  t.deepEqual(sim.status().output, { got: { done: 'yes' } });
});

test("a region final state named 'pending' is rejected as a reserved count key", t => {
  const chart = harden({
    name: 'collide',
    version: 1,
    initial: 'p',
    states: {
      p: {
        regions: [{ initial: 'pending', states: { pending: { final: true } } }],
        on: { 'regions-settled': [{ target: 'z' }] },
      },
      z: { final: true },
    },
  });
  t.throws(() => assertChart(chart), { message: /reserved join-count key/ });
});

test('diagnostics warn when a compound never handles state-done', t => {
  const chart = harden({
    name: 'deaf-compound',
    version: 1,
    initial: 'work',
    states: {
      work: {
        initial: 's1',
        states: {
          s1: { on: { next: [{ target: 'fin' }] } },
          fin: { final: true },
        },
      },
    },
  });
  const { warnings } = chartDiagnostics(chart);
  t.true(warnings.some(warning => /state-done/.test(warning)));
});

test('engineEventTypes collects internal, settlement, timer, and emit types', t => {
  const chart = harden({
    name: 'typed',
    version: 1,
    initial: 'a',
    states: {
      a: {
        entry: [
          {
            kind: 'ask',
            to: 'p',
            what: { description: 'q' },
            outcome: 'answered',
            failure: 'refused',
          },
          { kind: 'after', ms: 1000, emit: { type: 'expired' } },
        ],
        on: {
          answered: [
            {
              target: 'b',
              effects: [
                { kind: 'emit', event: { type: 'hop' } },
                {
                  kind: 'emit',
                  event: { type: 'dynamic-{$params.kind}' },
                },
              ],
            },
          ],
          refused: [{ target: 'b' }],
          expired: [{ target: 'b' }],
          hop: [{ target: 'b' }],
        },
      },
      b: { final: true },
    },
  });
  t.deepEqual(engineEventTypes(chart), [
    'answered',
    'cancel-requested',
    'effect-failed',
    'expired',
    'hop',
    'refused',
    'regions-settled',
    'state-done',
  ]);
  t.false(
    engineEventTypes(chart).some(type => type.startsWith('dynamic-')),
    'templated types are intentionally not reserved',
  );
});

test('control cannot forge settlements or region joins', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const seatChart = harden({
    initial: 'reviewing',
    states: {
      reviewing: {
        entry: [
          {
            kind: 'ask',
            to: 'reviewer',
            what: { description: 'review' },
            outcome: 'verdict',
          },
        ],
        on: { verdict: [{ target: 'approved' }] },
      },
      approved: { final: true },
    },
  });
  const chart = harden({
    name: 'protected-join',
    version: 1,
    initial: 'review',
    states: {
      review: {
        regions: [seatChart, seatChart],
        on: {
          probe: [{ assign: { probe: { $event: '' } } }],
          'regions-settled': [{ target: 'done' }],
        },
      },
      done: { final: true },
    },
  });
  const reviewer = Far('Reviewer', {});
  const { runId, control } = await E(service).start(chart, {
    endowments: harden({ reviewer }),
  });
  const engine = engines.get(runId);

  await t.throwsAsync(
    () => E(control).signal(harden({ type: 'verdict', value: 'forged' })),
    { message: /may not submit engine event type.*verdict/ },
  );
  await t.throwsAsync(
    () => E(control).signal(harden({ type: 'regions-settled' })),
    { message: /may not submit engine event type.*regions-settled/ },
  );
  await t.throwsAsync(
    () => E(control).signal(harden({ type: 'cancel-requested' })),
    { message: /may not submit engine event type.*cancel-requested/ },
  );
  await E(control).signal(
    harden({
      type: 'probe',
      value: 'ordinary',
      path: ['review', '#0', 'reviewing'],
      effectId: 'forged-effect',
      compensation: true,
      delivers: 'forged-delivery',
    }),
  );
  await until(() => engine.fold.context.probe !== undefined, 'probe signal');
  t.like(engine.fold.context.probe, {
    type: 'probe',
    value: 'ordinary',
    by: 'control',
  });
  for (const protectedName of [
    'path',
    'effectId',
    'compensation',
    'delivers',
  ]) {
    t.false(protectedName in engine.fold.context.probe);
  }
  t.false(engine.fold.done);
  t.is(engine.fold.configuration.state, 'review');
});

test('diagnostics reach inside $eachParam region charts', t => {
  const chart = harden({
    name: 'fanned',
    version: 1,
    params: M.splitRecord({ items: M.arrayOf(M.string()) }),
    initial: 'fan',
    states: {
      fan: {
        regions: {
          $eachParam: 'items',
          chart: {
            initial: 'w',
            states: {
              w: {
                entry: [
                  {
                    kind: 'invoke',
                    target: 'x',
                    method: 'go',
                    outcome: 'done-w',
                  },
                ],
                on: { other: [{ target: 'fin' }] },
              },
              fin: { final: true },
            },
          },
        },
        on: { 'regions-settled': [{ target: 'z' }] },
      },
      z: { final: true },
    },
  });
  const { errors } = chartDiagnostics(chart);
  t.true(errors.some(error => /#each/.test(error) && /done-w/.test(error)));
});

// #endregion

// #region ocap findings

test('charts must be capability-free: embedded remotables are refused', async t => {
  const { powers } = makeFakeAgent();
  const { service, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const sneaky = Far('Sneaky', { ping: async () => 'pong' });
  const chart = harden({
    name: 'cap-bearing',
    version: 1,
    initial: 'a',
    states: {
      a: {
        entry: [
          {
            kind: 'invoke',
            target: 'x',
            method: 'go',
            args: [sneaky],
            outcome: 'done-a',
          },
        ],
        on: { 'done-a': [{ target: 'b' }] },
      },
      b: { final: true },
    },
  });
  await t.throwsAsync(() => E(service).start(chart, {}), {
    message: /capability-free/,
  });
  await t.throwsAsync(() => E(service).install(chart), {
    message: /capability-free/,
  });
});

test('ports refuse engine event types and strip routing marks', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'guarded-port',
    version: 1,
    ports: { anyone: M.splitRecord({ type: M.string() }) },
    initial: 'outer',
    states: {
      outer: {
        initial: 'inner',
        states: {
          inner: {
            entry: [
              {
                kind: 'ask',
                to: 'p',
                what: { description: 'q' },
                outcome: 'answered',
              },
            ],
            on: { answered: [{ target: 'fin' }] },
          },
          fin: { final: true },
        },
        on: {
          'state-done': [{ target: 'ok' }],
          nudge: [{ target: 'ok' }],
        },
      },
      ok: { final: true },
    },
  });
  const { runId, control } = await E(service).start(chart, {
    endowments: harden({ p: harden({}) }),
  });
  const engine = engines.get(runId);
  const port = await E(control).port('anyone');
  // Internal and settlement types are the engine's to assert.
  await t.throwsAsync(() => E(port).submit(harden({ type: 'state-done' })), {
    message: /engine event type/,
  });
  await t.throwsAsync(
    () => E(port).submit(harden({ type: 'regions-settled' })),
    { message: /engine event type/ },
  );
  await t.throwsAsync(() => E(port).submit(harden({ type: 'answered' })), {
    message: /engine event type/,
  });
  // Ordinary events pass, with routing marks stripped.
  await E(port).submit(
    harden({
      type: 'nudge',
      path: ['outer', 'inner'],
      effectId: '9-9',
      delivers: '9-i9',
      compensation: true,
    }),
  );
  await until(() => engine.fold.done, 'run completion');
  const journal = await E(engine.runFacet).journal();
  const submitted = journal.find(entry => entry.by === 'port:anyone');
  t.is(submitted.event.path, undefined);
  t.is(submitted.event.effectId, undefined);
  t.is(submitted.event.delivers, undefined);
  t.is(submitted.event.compensation, undefined);
});

test('a depth-bomb settlement fails the effect loudly instead of wedging', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  /** @type {any} */
  let bomb = harden({ leaf: true });
  for (let i = 0; i < 200; i += 1) {
    bomb = harden({ deeper: bomb });
  }
  const worker = Far('W', { go: async _effectId => bomb });
  const chart = harden({
    name: 'bombed',
    version: 1,
    initial: 'w',
    states: {
      w: {
        entry: [
          {
            kind: 'invoke',
            target: 'x',
            method: 'go',
            outcome: 'done-w',
            failure: 'broke-w',
          },
        ],
        on: {
          'done-w': [{ target: 'ok' }],
          'broke-w': [{ target: 'sad' }],
        },
      },
      ok: { final: true },
      sad: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {
    endowments: harden({ x: worker }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run settled');
  // The unencodable value became a failed settlement, routed to the
  // declared failure handler — visible, not wedged.
  t.is(engine.fold.configuration.state, 'sad');
  const journal = await E(engine.runFacet).journal();
  const settlement = journal.find(entry => entry.settles !== undefined);
  t.is(settlement.settles.status, 'failed');
  t.regex(settlement.settles.reason, /settlement value rejected/);
});

// #endregion

// #region durability findings

test('resume stops at a terminal outcome; nothing steps past the end', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const { target } = (() => {
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    return {
      target: Far('Slow', {
        go: async _effectId => gate,
        release: () => release('answer'),
      }),
    };
  })();
  const deaf = harden({
    name: 'deaf-resume',
    version: 1,
    initial: 'w',
    states: {
      w: {
        entry: [
          { kind: 'invoke', target: 'x', method: 'go', outcome: 'done-w' },
        ],
        on: { never: [{ target: 'ok' }], go: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { runId, control } = await E(service).start(deaf, {
    endowments: harden({ x: target }),
  });
  const engine = engines.get(runId);
  await E(control).pause();
  // The settlement arrives while paused (queued), then an ordinary
  // event queues after it.
  await E(target).release();
  await until(
    () => /** @type {number} */ (engine.fold.queuedEvents.size) >= 1,
    'settlement queued',
  );
  await E(control).signal(harden({ type: 'go' }));
  await until(() => engine.fold.queuedEvents.size === 2, 'event queued');
  await E(control).resume();
  await until(() => engine.fold.done, 'run failed');
  // The unhandled settlement failed the run; the queued `go` must NOT
  // have stepped a failed run to `ok`.
  t.is(engine.fold.outcome, 'failed');
  t.not(engine.fold.configuration.state, 'ok');
  const journal = await E(engine.runFacet).journal();
  const terminalIndex = journal.findIndex(
    entry => entry.terminal !== undefined,
  );
  t.is(terminalIndex, journal.length - 1);
});

test('a crash mid-resume strands nothing: recovery drains the queue', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = false;
  const wrapped = crashingPowers(
    powers,
    value => crashArmed && value.replays !== undefined,
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'queued',
    version: 1,
    context: { hops: 0 },
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b', assign: { hops: { $inc: 1 } } }] } },
      b: { on: { go: [{ target: 'c', assign: { hops: { $inc: 1 } } }] } },
      c: { final: true, output: { hops: { $ctx: 'hops' } } },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  await E(control).pause();
  await E(control).signal(harden({ type: 'go' }));
  await E(control).signal(harden({ type: 'go' }));
  await settle();
  crashArmed = true;
  // The first replay's write dies; `resumed` landed, the queue did not
  // drain.
  await t.throwsAsync(() => E(control).resume(), {
    message: /simulated crash/,
  });
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const engine = h2.engines.get(runId);
  await until(() => engine.fold.done, 'queue drained on recovery');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { hops: 2 });
});

test('paused cancellation and unpause recover as one durable step', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = false;
  const wrapped = crashingPowers(
    powers,
    value => crashArmed && value.replays !== undefined,
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'cancel-recovery',
    version: 1,
    initial: 'working',
    states: {
      working: {
        on: { 'cancel-requested': [{ target: 'reconciling' }] },
      },
      reconciling: { on: { 'cleanup-done': [{ target: 'done' }] } },
      done: { final: true, output: { status: 'reconciled' } },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  await E(control).pause();
  await E(control).signal(harden({ type: 'cleanup-done' }));
  await settle();
  crashArmed = true;
  // The atomic cancel transition lands, but the first queued replay does not.
  await t.throwsAsync(() => E(control).cancel('test crash'), {
    message: /simulated crash/,
  });
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const engine = h2.engines.get(runId);
  await until(() => engine.fold.done, 'cancel queue drained on recovery');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { status: 'reconciled' });
  const journal = await E(engine.runFacet).journal();
  const cancellation = journal.find(
    entry => entry.event?.type === 'cancel-requested',
  );
  t.true(cancellation.unpauses);
  t.is(cancellation.fired.configuration.state, 'reconciling');
});

test('child cancellation is durable before the parent request', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = false;
  let parentRunId = '';
  const wrapped = crashingPowers(
    powers,
    (value, path) =>
      crashArmed &&
      value.event?.type === 'cancel-requested' &&
      Array.isArray(path) &&
      path.includes(parentRunId),
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const childChart = harden({
    name: 'safe-child',
    version: 1,
    initial: 'live',
    states: {
      live: { on: { 'cancel-requested': [{ target: 'safe' }] } },
      safe: { final: true, output: { status: 'safe' } },
    },
  });
  const chart = harden({
    name: 'safe-parent',
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
          'child-done': [{ target: 'safe' }],
          'cancel-requested': [{}],
        },
      },
      safe: { final: true, output: { status: 'child-safe' } },
    },
  });
  const started = await E(h1.service).start(chart, {});
  parentRunId = started.runId;
  const parent = h1.engines.get(parentRunId);
  await until(
    () =>
      [...parent.fold.pending.values()].some(
        record => record.childRunId !== undefined,
      ),
    'child spawned',
  );
  const childRunId = [...parent.fold.pending.values()].find(
    record => record.childRunId !== undefined,
  ).childRunId;
  crashArmed = true;
  // The child request lands; the immediately following parent request does not.
  await t.throwsAsync(() => E(started.control).cancel('test crash'), {
    message: /simulated crash/,
  });
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const child = h2.engines.get(childRunId);
  t.true(child.fold.done);
  t.deepEqual(child.fold.output, { status: 'safe' });
  const recoveredParent = h2.engines.get(parentRunId);
  await until(() => recoveredParent.fold.done, 'safe child settles parent');
  t.deepEqual(recoveredParent.fold.output, { status: 'child-safe' });
});

test('recovery cancels revoked-factory runs before effect rearm', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = false;
  const wrapped = crashingPowers(
    powers,
    value => crashArmed && value.event?.type === 'cancel-requested',
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  let calls = 0;
  const worker = Far('HazardousWorker', {
    perform: async _effectId => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  const chart = harden({
    name: 'revoked-hazard',
    version: 1,
    initial: 'working',
    states: {
      working: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            outcome: 'worked',
          },
        ],
        on: {
          worked: [{ target: 'unsafe' }],
          'cancel-requested': [{ target: 'safe' }],
        },
      },
      unsafe: { final: true },
      safe: { final: true, output: { status: 'revoked-safe' } },
    },
  });
  const { factory } = await E(h1.service).makeFactory({
    chart,
    endowments: harden({ worker }),
  });
  const { runId } = await E(factory).start({});
  const engine = h1.engines.get(runId);
  await until(() => engine.fold.pending.size === 1, 'invoke pending');
  t.is(calls, 1);
  crashArmed = true;
  // The factory record is revoked, but the following run-journal write dies.
  await t.throwsAsync(() => E(factory).revoke('test crash'), {
    message: /simulated crash/,
  });
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const recovered = h2.engines.get(runId);
  t.true(recovered.fold.done);
  t.deepEqual(recovered.fold.output, { status: 'revoked-safe' });
  t.is(calls, 1, 'the hazardous invoke was not rearmed before cancellation');
});

test('failed live revocation quarantines settlements until a retry', async t => {
  const { powers } = makeFakeAgent();
  let crashArmed = false;
  const wrapped = crashingPowers(
    powers,
    value => crashArmed && value.event?.type === 'cancel-requested',
  );
  const harness = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('live'),
  });
  t.teardown(harness.stop);
  let finish;
  let calls = 0;
  const worker = Far('DeferredHazardousWorker', {
    perform: async _effectId => {
      calls += 1;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  const chart = harden({
    name: 'live-revocation-failure',
    version: 1,
    initial: 'working',
    states: {
      working: {
        entry: [
          {
            kind: 'invoke',
            target: 'worker',
            method: 'perform',
            outcome: 'worked',
          },
        ],
        on: {
          worked: [{ target: 'unsafe' }],
          'cancel-requested': [{ target: 'safe' }],
        },
      },
      unsafe: { final: true },
      safe: { final: true, output: { status: 'revoked-safe' } },
    },
  });
  const { factory } = await E(harness.service).makeFactory({
    chart,
    endowments: harden({ worker }),
  });
  const { runId } = await E(factory).start({});
  const engine = harness.engines.get(runId);
  await until(() => engine.fold.pending.size === 1, 'invoke pending');
  t.is(calls, 1);

  crashArmed = true;
  await t.throwsAsync(() => E(factory).revoke('injected write failure'), {
    message: /simulated crash/,
  });
  crashArmed = false;
  finish('hazard completed after failed revocation');
  await settle();
  t.false(engine.fold.done);
  t.is(engine.fold.configuration.state, 'working');
  t.is(engine.fold.pending.size, 1);

  await E(factory).revoke('retry');
  t.true(engine.fold.done);
  t.deepEqual(engine.fold.output, { status: 'revoked-safe' });
  t.is(calls, 1);
});

test('partial descendant revocation denies starts until a retry', async t => {
  const { powers } = makeFakeAgent();
  let crashArmed = false;
  /** @type {string | undefined} */
  let blockedFid;
  const wrapped = crashingPowers(
    powers,
    value => crashArmed && value.revoked === true && value.fid === blockedFid,
  );
  const harness = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('records'),
  });
  t.teardown(harness.stop);
  const chart = harden({
    name: 'factory-record-failure',
    version: 1,
    initial: 'done',
    states: { done: { final: true } },
  });
  const { factory } = await E(harness.service).makeFactory({ chart });
  const derived = await E(factory).with({});
  blockedFid = (await E(derived).describe()).fid;

  crashArmed = true;
  await t.throwsAsync(() => E(factory).revoke('injected record failure'), {
    message: /simulated crash/,
  });
  await t.throwsAsync(() => E(derived).start({}), {
    message: /is revoked/,
  });

  crashArmed = false;
  await E(factory).revoke('retry');
  t.true((await E(derived).describe()).revoked);
});

test('handled cancellation durably suppresses later child spawns', async t => {
  const { powers, controls } = makeFakeAgent();
  const h1 = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter('before'),
  });
  const childChart = harden({
    name: 'must-not-start',
    version: 1,
    initial: 'unsafe',
    states: { unsafe: { final: true } },
  });
  const chart = harden({
    name: 'cancel-before-spawn',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        on: {
          'cancel-requested': [{}],
          go: [{ target: 'spawning' }],
        },
      },
      spawning: {
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: {},
            outcome: 'child-done',
            failure: 'child-failed',
          },
        ],
        on: {
          'child-done': [{ target: 'unsafe' }],
          'child-failed': [{ target: 'safe' }],
        },
      },
      unsafe: { final: true },
      safe: { final: true, output: { status: 'spawn-suppressed' } },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  await E(control).cancel('withdraw authority');
  t.true(h1.engines.get(runId).fold.cancellationRequested);
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('after'),
  });
  t.teardown(h2.stop);
  const recoveredControl = await E(h2.service).control(runId);
  await E(recoveredControl).signal(harden({ type: 'go' }));
  const recovered = h2.engines.get(runId);
  await until(() => recovered.fold.done, 'suppressed spawn reconciled');
  t.deepEqual(recovered.fold.output, { status: 'spawn-suppressed' });
  t.is(h2.engines.size, 1, 'no child run was created');
});

test('a lost emit delivery is re-dispatched from its journaled obligation', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = true;
  const wrapped = crashingPowers(
    powers,
    value =>
      crashArmed &&
      value.kind === 'event' &&
      value.event !== undefined &&
      value.event.delivers !== undefined,
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'hopper',
    version: 1,
    initial: 'a',
    states: {
      a: {
        on: {
          go: [
            {
              target: 'b',
              effects: [{ kind: 'emit', event: { type: 'hop' } }],
            },
          ],
        },
      },
      b: { on: { hop: [{ target: 'c' }] } },
      c: { final: true },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  const engine1 = h1.engines.get(runId);
  await E(control).signal(harden({ type: 'go' }));
  await settle();
  // The transition landed; the emitted `hop`'s own entry could not.
  t.is(engine1.fold.configuration.state, 'b');
  t.is(engine1.fold.pendingInternals.size, 1);
  h1.stop();
  crashArmed = false;

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const engine2 = h2.engines.get(runId);
  await until(() => engine2.fold.done, 'obligation re-delivered');
  t.is(engine2.fold.outcome, 'completed');
  t.is(engine2.fold.pendingInternals.size, 0);
});

test('a spawn crash window adopts the child instead of duplicating it', async t => {
  const { powers, controls } = makeFakeAgent();
  let crashArmed = true;
  // A real crash kills every write from that moment on: the `spawned`
  // linkage entry AND the failed-settlement conversion the engine now
  // attempts for the dispatch throw. Both must die for the crash
  // window to stay open.
  const wrapped = crashingPowers(
    powers,
    value =>
      crashArmed && (value.kind === 'spawned' || value.settles !== undefined),
  );
  const h1 = await makeWorkflowService({
    powers: wrapped,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const childChart = harden({
    name: 'kid',
    version: 1,
    initial: 'wait',
    states: {
      wait: { on: { verdict: [{ target: 'fin' }] } },
      fin: { final: true, output: { v: 'done' } },
    },
  });
  const parentChart = harden({
    name: 'parent',
    version: 1,
    initial: 'spawning',
    states: {
      spawning: {
        entry: [{ kind: 'spawn', chart: childChart, outcome: 'child-done' }],
        on: { 'child-done': [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  // The child run is created durably; the parent's `spawned` linkage
  // write dies, and so does the failed-settlement conversion — the
  // parent is left with the spawn pending and unlinked.
  const parent1 = await E(h1.service).start(parentChart, {});
  const engine1 = h1.engines.get(parent1.runId);
  await settle();
  const journal1 = await E(engine1.runFacet).journal();
  t.false(journal1.some(entry => entry.kind === 'spawned'));
  t.false(journal1.some(entry => entry.settles !== undefined));
  t.false(engine1.fold.done);
  h1.stop();
  crashArmed = false;

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  // Exactly two runs exist: the parent and ONE child, adopted by its
  // deterministic id.
  const summaries = await E(h2.service).list();
  t.is(summaries.length, 2);
  const parent = summaries.find(summary => summary.chartName === 'parent');
  const child = summaries.find(summary => summary.chartName === 'kid');
  t.is(child.runId, `${parent.runId}-c0-0`);
  const parentEngine = h2.engines.get(parent.runId);
  await until(
    () =>
      [...parentEngine.fold.pending.values()].some(
        record => record.childRunId === child.runId,
      ),
    'spawned linkage re-journaled',
  );
  const childControl = await E(h2.service).control(child.runId);
  await E(childControl).signal(harden({ type: 'verdict' }));
  await until(() => parentEngine.fold.done, 'parent completion');
  t.is(parentEngine.fold.outcome, 'completed');
});

test('one corrupt run and one aborted mint do not brick recovery', async t => {
  const { powers, controls } = makeFakeAgent();
  const h1 = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'healthy',
    version: 1,
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b' }] } },
      b: { final: true },
    },
  });
  const good = await E(h1.service).start(chart, {});
  const bad = await E(h1.service).start(chart, {});
  h1.stop();
  // Corrupt one run's journal (seq discontinuity) and plant an aborted
  // mint (a run directory with no chart, no entries).
  const entry0 = controls.peek(['workflow', 'runs', bad.runId, '0']);
  await E(powers).storeValue(harden({ ...entry0, seq: 7n }), [
    'workflow',
    'runs',
    bad.runId,
    '0',
  ]);
  await E(powers).makeDirectory(['workflow', 'runs', 'r-aborted']);

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  t.truthy(h2.engines.get(good.runId));
  t.is(h2.engines.get(bad.runId), undefined);
  t.is(h2.engines.get('r-aborted'), undefined);
  const goodControl = await E(h2.service).control(good.runId);
  await E(goodControl).signal(harden({ type: 'go' }));
  await until(() => h2.engines.get(good.runId).fold.done, 'good run works');
});

test('a rejected start leaves no phantom run behind', async t => {
  const { powers, controls } = makeFakeAgent();
  const h1 = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'strict',
    version: 1,
    params: M.splitRecord({ must: M.string() }),
    initial: 'a',
    states: { a: { final: true } },
  });
  await t.throwsAsync(
    () => E(h1.service).start(chart, { params: harden({ must: 7 }) }),
    { message: /must/ },
  );
  h1.stop();
  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  t.deepEqual(await E(h2.service).list(), []);
});

test('a real snapshot crossing recovers and verifies end to end', async t => {
  const { powers, controls } = makeFakeAgent();
  const h1 = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter('a'),
  });
  const chart = harden({
    name: 'long-runner',
    version: 1,
    context: { hops: 0 },
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b', assign: { hops: { $inc: 1 } } }] } },
      b: {
        on: {
          go: [{ target: 'a', assign: { hops: { $inc: 1 } } }],
          stop: [{ target: 'fin' }],
        },
      },
      fin: { final: true, output: { hops: { $ctx: 'hops' } } },
    },
  });
  const { runId, control } = await E(h1.service).start(chart, {});
  const engine1 = h1.engines.get(runId);
  for (let i = 0; i < 70; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(control).signal(harden({ type: 'go' }));
  }
  await until(() => engine1.fold.context.hops === 70, 'hops accumulated');
  const journal1 = await E(engine1.runFacet).journal();
  t.true(journal1.some(entry => entry.kind === 'snapshot'));
  t.true(verifyJournalChain(journal1).ok);
  h1.stop();

  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock: makeFakeClock(),
    makeId: makeIdCounter('b'),
  });
  t.teardown(h2.stop);
  const engine2 = h2.engines.get(runId);
  t.is(engine2.fold.context.hops, 70);
  t.is(engine2.summary().integrity, undefined);
  const client = makeRunSyncClient(engine2.runFacet, {
    iterateEntries: iterateReader,
  });
  t.teardown(client.stop);
  const control2 = await E(h2.service).control(runId);
  // After an even hop count the machine sits in `a`; hop once into `b`
  // where `stop` is declared.
  await E(control2).signal(harden({ type: 'go' }));
  await E(control2).signal(harden({ type: 'stop' }));
  await until(() => engine2.fold.done, 'run completion');
  await client.done();
  t.true(client.verify().ok);
  t.deepEqual(client.current().output, { hops: 71 });
  t.is(client.stateAt(3n).context.hops, 2);
});

test('resolveRef still works after the run completes', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const token = Far('Token', { poke: async () => 'poked' });
  const minter = Far('Minter', { mint: async _effectId => token });
  const chart = harden({
    name: 'cap-then-done',
    version: 1,
    initial: 'get',
    states: {
      get: {
        entry: [
          {
            kind: 'invoke',
            target: 'minter',
            method: 'mint',
            outcome: 'minted',
          },
        ],
        on: { minted: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { runId, run, control } = await E(service).start(chart, {
    endowments: harden({ minter }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  const recovered = await E(control).resolveRef('ref-0');
  t.is(await E(recovered).poke(), 'poked');
  const journal = await E(run).journal();
  const admin = journal[journal.length - 1];
  t.is(admin.kind, 'admin');
  t.true(verifyJournalChain(journal).ok);
  // A settled run accepts no further events.
  await t.throwsAsync(() => E(control).signal(harden({ type: 'x' })), {
    message: /no further events/,
  });
});

test('promises in settlements redact to a marker, not a wedge', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const worker = Far('W', {
    go: async _effectId => harden({ later: Promise.resolve('x'), note: 'hi' }),
  });
  const chart = harden({
    name: 'promissory',
    version: 1,
    initial: 'w',
    states: {
      w: {
        entry: [
          { kind: 'invoke', target: 'x', method: 'go', outcome: 'done-w' },
        ],
        on: {
          'done-w': [{ target: 'ok', assign: { got: { $event: 'value' } } }],
        },
      },
      ok: { final: true, output: { got: { $ctx: 'got' } } },
    },
  });
  const { runId } = await E(service).start(chart, {
    endowments: harden({ x: worker }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run completion');
  t.deepEqual(engine.fold.output, {
    got: { later: '<promise>', note: 'hi' },
  });
});

test('a late answer to a cancelled run drops as stale', async t => {
  const { powers, controls } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'cancellable-ask',
    version: 1,
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            what: { description: 'well?' },
            outcome: 'answered',
          },
        ],
        on: { answered: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { runId, control } = await E(service).start(chart, {
    endowments: harden({ operator: harden({}) }),
  });
  const engine = engines.get(runId);
  await until(
    () => controls.findMessage('request', `[workflow ${runId}`) !== undefined,
    'ask sent',
  );
  await E(control).cancel('changed my mind');
  await until(() => engine.fold.done, 'run cancelled');
  await controls.resolveRequest(
    controls.findMessage('request', `[workflow ${runId}`),
    'too late',
  );
  await settle();
  t.is(engine.fold.outcome, 'cancelled');
  const journal = await E(engine.runFacet).journal();
  t.false(journal.some(entry => entry.settles !== undefined));
});

test('sync client stop() before follow resolves closes cleanly', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'briefly-watched',
    version: 1,
    initial: 'a',
    states: {
      a: { on: { go: [{ target: 'b' }] } },
      b: { final: true },
    },
  });
  const { runId, run, control } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  const client = makeRunSyncClient(run, { iterateEntries: iterateReader });
  client.stop();
  await client.done();
  await E(control).signal(harden({ type: 'go' }));
  await until(() => engine.fold.done, 'run completion');
  // The stopped client accumulated nothing after stop.
  t.true(client.entries().length <= 1);
  t.false(client.isBroken());
});

// #endregion
