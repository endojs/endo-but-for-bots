// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';

import { canonicalStringify } from '../src/journal.js';
import { makeWorkflowService } from '../src/service.js';
import { makeSimulator } from '../src/simulate.js';
import { makeFakeAgent, makeFakeClock } from './fake-agent.js';

/**
 * Regressions for the PR-review blockers: dispatch-time throws must
 * become failed settlements rather than stranded pending effects, timer
 * deadlines beyond Node's 2^31-1 ms setTimeout ceiling must arm in
 * bounded hops rather than fire immediately, and the journal's symbol
 * encoding must be injective across well-known and registered symbols.
 */

const MAX_TIMER_MS = 2 ** 31 - 1;

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

// #region journal symbol encoding

test('symbol encoding distinguishes well-known from registered symbols', t => {
  // `Symbol.iterator` and `Symbol.for('Symbol.iterator')` share a
  // `description`; an encoding keyed on it would let one substitute for
  // the other under an unchanged hash.
  const wellKnown = canonicalStringify(harden({ v: Symbol.iterator }));
  const registered = canonicalStringify(
    harden({ v: Symbol.for('Symbol.iterator') }),
  );
  const escaped = canonicalStringify(harden({ v: Symbol.for('@@iterator') }));
  t.is(wellKnown, '{"v":{"#sym":"@@iterator"}}');
  t.not(wellKnown, registered);
  t.not(wellKnown, escaped);
  t.not(registered, escaped);
});

test('unpassable symbols are refused, not silently conflated', t => {
  // Nested, the record walk's passStyleOf gate refuses the symbol; bare,
  // the symbol branch's own guard does. Both messages name passability.
  t.throws(() => canonicalStringify(harden({ v: Symbol('one-off') })), {
    message: /passable/,
  });
  t.throws(() => canonicalStringify(Symbol('one-off')), {
    message: /passable/,
  });
});

// #endregion

// #region timer overflow

test('a deadline beyond the setTimeout ceiling arms in bounded hops', async t => {
  const clock = makeFakeClock();
  /** @type {number[]} */
  const delays = [];
  const recordingClock = harden({
    now: () => clock.now(),
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return clock.setTimeout(fn, ms);
    },
    /** @param {number} handle */
    clearTimeout: handle => clock.clearTimeout(handle),
  });
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: recordingClock,
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  // ~40 days: past 2^31-1 ms (~24.9 days), where Node's setTimeout
  // clamps the delay to 1 ms and a naive arm fires immediately.
  const fortyDays = 40 * 24 * 60 * 60 * 1000;
  const chart = harden({
    name: 'long-wait',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ kind: 'after', ms: fortyDays, emit: { type: 'expired' } }],
        on: { expired: [{ target: 'fin' }] },
      },
      fin: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  // The host never sees a delay beyond the ceiling: the deadline splits
  // into one full hop and one remainder hop.
  t.true(delays.every(ms => ms <= MAX_TIMER_MS));
  t.deepEqual(delays, [MAX_TIMER_MS]);
  // The run must NOT have fired early.
  t.false(engine.fold.done);
  await clock.advance(fortyDays);
  await until(() => engine.fold.done, 'deadline elapsed');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(delays, [MAX_TIMER_MS, fortyDays - MAX_TIMER_MS]);
});

test('a deadline exactly at 2^31 ms hops once and fires on time', async t => {
  const clock = makeFakeClock();
  /** @type {number[]} */
  const delays = [];
  const recordingClock = harden({
    now: () => clock.now(),
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return clock.setTimeout(fn, ms);
    },
    /** @param {number} handle */
    clearTimeout: handle => clock.clearTimeout(handle),
  });
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: recordingClock,
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const boundary = 2 ** 31;
  const chart = harden({
    name: 'boundary-wait',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ kind: 'after', ms: boundary, emit: { type: 'expired' } }],
        on: { expired: [{ target: 'fin' }] },
      },
      fin: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  t.deepEqual(delays, [MAX_TIMER_MS]);
  await clock.advance(boundary);
  await until(() => engine.fold.done, 'boundary deadline elapsed');
  t.is(engine.fold.outcome, 'completed');
  // One full hop plus the single leftover millisecond.
  t.deepEqual(delays, [MAX_TIMER_MS, 1]);
});

// #endregion

// #region dispatch-time throws

test('an unparseable after.at becomes a failed settlement, not a wedge', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'bad-deadline',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [
          {
            kind: 'after',
            at: 'not-a-date',
            emit: { type: 'expired' },
            failure: 'timer-broke',
          },
        ],
        on: {
          expired: [{ target: 'ok' }],
          'timer-broke': [{ target: 'sad' }],
        },
      },
      ok: { final: true },
      sad: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'dispatch failure settled');
  // The throw was routed to the declared failure handler.
  t.is(engine.fold.configuration.state, 'sad');
  t.is(engine.fold.outcome, 'completed');
  const journal = await E(engine.runFacet).journal();
  const settlement = journal.find(entry => entry.settles !== undefined);
  t.is(settlement.settles.status, 'failed');
  t.regex(settlement.settles.reason, /dispatch failed/);
  t.regex(settlement.settles.reason, /parseable date/);
});

test('an unhandled timer dispatch failure is fail-loud terminal', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'deaf-deadline',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ kind: 'after', at: 'garbage', emit: { type: 'expired' } }],
        on: { expired: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {});
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'run failed loudly');
  t.is(engine.fold.outcome, 'failed');
  const journal = await E(engine.runFacet).journal();
  const terminal = journal[journal.length - 1];
  t.is(terminal.terminal.outcome, 'failed');
  t.regex(terminal.terminal.reason, /unhandled 'effect-failed' settlement/);
});

test('a rejected form send becomes a failed settlement', async t => {
  const { powers } = makeFakeAgent();
  const brokenMailroom = harden({
    has: (...segments) => E(powers).has(...segments),
    list: (...segments) => E(powers).list(...segments),
    lookup: nameOrPath => E(powers).lookup(nameOrPath),
    maybeLookup: nameOrPath => E(powers).maybeLookup(nameOrPath),
    makeDirectory: nameOrPath => E(powers).makeDirectory(nameOrPath),
    storeValue: (value, nameOrPath) => E(powers).storeValue(value, nameOrPath),
    request: (...args) => E(powers).request(...args),
    form: async () => {
      throw Error('mailroom unavailable');
    },
    listMessages: () => E(powers).listMessages(),
    followMessages: () => E(powers).followMessages(),
  });
  const { service, engines, stop } = await makeWorkflowService({
    powers: brokenMailroom,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const chart = harden({
    name: 'unaskable',
    version: 1,
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            kind: 'ask',
            to: 'operator',
            form: {
              description: 'Approve?',
              fields: [{ name: 'approved', label: 'OK?' }],
            },
            outcome: 'submitted',
            failure: 'ask-broke',
          },
        ],
        on: {
          submitted: [{ target: 'ok' }],
          'ask-broke': [{ target: 'sad' }],
        },
      },
      ok: { final: true },
      sad: { final: true },
    },
  });
  const { runId } = await E(service).start(chart, {
    endowments: harden({ operator: harden({}) }),
  });
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'form failure settled');
  t.is(engine.fold.configuration.state, 'sad');
  const journal = await E(engine.runFacet).journal();
  const settlement = journal.find(entry => entry.settles !== undefined);
  t.is(settlement.settles.status, 'failed');
  t.regex(settlement.settles.reason, /dispatch failed: mailroom unavailable/);
});

test('a spawn whose child params refuse its chart becomes a failed settlement', async t => {
  const { powers } = makeFakeAgent();
  const { service, engines, stop } = await makeWorkflowService({
    powers,
    clock: makeFakeClock(),
    makeId: makeIdCounter(),
  });
  t.teardown(stop);
  const childChart = harden({
    name: 'strict-kid',
    version: 1,
    params: M.splitRecord({ must: M.string() }),
    initial: 'a',
    states: { a: { final: true } },
  });
  const parentChart = harden({
    name: 'bad-parent',
    version: 1,
    initial: 'spawning',
    states: {
      spawning: {
        entry: [
          {
            kind: 'spawn',
            chart: childChart,
            params: { must: 7 },
            outcome: 'child-done',
            failure: 'spawn-broke',
          },
        ],
        on: {
          'child-done': [{ target: 'ok' }],
          'spawn-broke': [{ target: 'sad' }],
        },
      },
      ok: { final: true },
      sad: { final: true },
    },
  });
  const { runId } = await E(service).start(parentChart, {});
  const engine = engines.get(runId);
  await until(() => engine.fold.done, 'spawn failure settled');
  t.is(engine.fold.configuration.state, 'sad');
  const journal = await E(engine.runFacet).journal();
  const settlement = journal.find(entry => entry.settles !== undefined);
  t.is(settlement.settles.status, 'failed');
  t.regex(settlement.settles.reason, /dispatch failed/);
  // The aborted child mint left no phantom run behind.
  const summaries = await E(service).list();
  t.is(summaries.length, 1);
  t.is(summaries[0].runId, runId);
});

test('simulator parity: a failed after settlement with no handler is fail-loud', t => {
  const chart = harden({
    name: 'sim-deaf-timer',
    version: 1,
    initial: 'waiting',
    states: {
      waiting: {
        entry: [{ kind: 'after', ms: 5, emit: { type: 'expired' } }],
        on: { expired: [{ target: 'ok' }] },
      },
      ok: { final: true },
    },
  });
  const sim = makeSimulator(chart);
  const [timer] = sim
    .pending()
    .filter(record => record.effect.kind === 'after');
  const status = sim.settle(timer.effectId, 'failed', 'clock broke');
  t.true(status.done);
  t.is(status.outcome, 'failed');
  t.regex(status.reason, /unhandled 'effect-failed' settlement/);
});

// #endregion
