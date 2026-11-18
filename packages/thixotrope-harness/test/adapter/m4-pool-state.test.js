// @ts-check
// M4 W4.2: the manager bridge of one pool
// (resources/agent-host/impl/subscriptions/pool-state.js;
// designs/m4-interfaces.md 3.1 sink additions, 5.1, 10). A fake sink
// records deliveries; a fake clock drives the coalescing timer. Checks:
// marks sent at once (one delivery per refusal), served stamps coalesced
// (at most one delivery per flush window per pool, chunks of 32), one
// `poolState` per incarnation, a retired sink reloads, and the core and the
// bridge together. No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { m4Shapes } from '../../guest/lib/interfaces-m4.js';
/* eslint-enable import/no-relative-packages */
import {
  initialFromPoolState,
  makePoolStateBridge,
} from '../../resources/agent-host/impl/subscriptions/pool-state.js';
import { makePoolCore } from '../../resources/agent-host/impl/subscriptions/pool.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const RETIRED = 'ocapn hub: the target session has been retired';
const NOW = Date.parse('2026-09-20T12:00:00.000Z');

/** A fake clock with the adapter's `Timers` shape. */
const makeFakeTimers = () => {
  /** @type {{ at: number, fn: () => void, live: boolean }[]} */
  const queue = [];
  let clock = 0;
  return {
    timers: harden({
      delay: async () => {},
      after: (/** @type {number} */ ms, /** @type {() => void} */ fn) => {
        const item = { at: clock + ms, fn, live: true };
        queue.push(item);
        return () => {
          item.live = false;
        };
      },
    }),
    /** @param {number} ms */
    advance: ms => {
      clock += ms;
      for (const item of [...queue]) {
        if (item.live && item.at <= clock) {
          item.live = false;
          item.fn();
        }
      }
    },
    armed: () => queue.filter(item => item.live).length,
  };
};

/**
 * @param {object} [options]
 * @param {any} [options.state]
 * @param {number} [options.failLoads]
 */
const makeFakeSink = ({ state, failLoads = 0 } = {}) => {
  /** @type {any[]} */
  const changes = [];
  let loads = 0;
  let failures = failLoads;
  const sink = Far('AgentHostSink', {
    poolState: async (/** @type {any} */ _backend) => {
      loads += 1;
      if (failures > 0) {
        failures -= 1;
        throw Error(RETIRED);
      }
      return state;
    },
    poolChanged: (/** @type {any} */ backend, /** @type {any} */ change) => {
      changes.push({ backend, change });
    },
  });
  return { sink, changes, loads: () => loads };
};

const settle = () => new Promise(resolve => setImmediate(resolve));

const member = (/** @type {string} */ label) =>
  harden({
    member: Far('PoolMember', {}),
    label,
    provider: 'codex',
    weight: 1,
    key: `k${label.length}`,
    state: 'active',
  });

test('load asks the manager once per incarnation and a retired break reloads', async t => {
  const a = member('A');
  const session = Far('Session', {});
  const state = harden({
    state: 'active',
    members: [
      {
        ...a,
        mark: { untilMs: NOW + 1000, strikes: 1, sinceMs: NOW, dated: true },
      },
    ],
    served: [{ session, member: a.member, at: NOW }],
  });
  const fake = makeFakeSink({ state, failLoads: 1 });
  const { timers } = makeFakeTimers();
  const backend = Far('Backend', {});
  const bridge = makePoolStateBridge({
    sink: () => fake.sink,
    backend,
    timers,
  });
  await t.throwsAsync(() => bridge.load(), { message: RETIRED });
  const loaded = await bridge.load();
  t.is(loaded, await bridge.load(), 'cached');
  await bridge.load();
  t.is(fake.loads(), 2, 'one failed and one good load');
  t.true(matches(loaded, m4Shapes.PoolState));
  const initial = initialFromPoolState(loaded);
  t.is(initial.marks.length, 1);
  t.is(initial.marks[0].member, a.member);
  t.is(initial.served[0].session, session);
});

test('a new sink (manager restarted, adapter re-attached) is asked again', async t => {
  const state = harden({ state: 'active', members: [], served: [] });
  const first = makeFakeSink({ state });
  const second = makeFakeSink({ state });
  let current = first.sink;
  const { timers } = makeFakeTimers();
  const bridge = makePoolStateBridge({
    sink: () => current,
    backend: Far('Backend', {}),
    timers,
  });
  await bridge.load();
  await bridge.load();
  current = second.sink;
  await bridge.load();
  t.is(first.loads(), 1);
  t.is(second.loads(), 1);
});

test('marks go at once, one delivery each; served stamps are coalesced', async t => {
  const fake = makeFakeSink();
  const fakeTimers = makeFakeTimers();
  const backend = Far('Backend', {});
  const bridge = makePoolStateBridge({
    sink: fake.sink,
    backend,
    timers: fakeTimers.timers,
  });
  const a = member('A');
  const sessions = Array.from({ length: 40 }, () => Far('Session', {}));
  // 40 stamps, one session stamped three times: they wait.
  for (const [index, session] of sessions.entries()) {
    bridge.record({ served: [{ session, member: a.member, at: NOW + index }] });
  }
  bridge.record({
    served: [{ session: sessions[0], member: a.member, at: NOW + 99 }],
  });
  await settle();
  t.is(fake.changes.length, 0);
  t.is(bridge.pending(), 40);
  t.is(fakeTimers.armed(), 1, 'one timer per pool, not per stamp');
  // The window passes: 40 stamps in two messages of at most 32.
  fakeTimers.advance(1000);
  await settle();
  t.is(fake.changes.length, 2);
  t.is(fake.changes[0].change.served.length, 32);
  t.is(fake.changes[1].change.served.length, 8);
  t.is(fake.changes[0].backend, backend);
  const all = fake.changes.flatMap(c => c.change.served);
  t.is(all.find(r => r.session === sessions[0]).at, NOW + 99, 'latest kept');
  for (const { change } of fake.changes) {
    t.true(matches(change, m4Shapes.PoolChange));
  }
  // A mark goes at once and carries the stamps waiting with it.
  bridge.record({
    served: [{ session: sessions[1], member: a.member, at: NOW + 200 }],
  });
  const mark = {
    untilMs: NOW + 60_000,
    strikes: 1,
    sinceMs: NOW,
    dated: false,
  };
  bridge.record({ marks: [{ member: a.member, mark }] });
  await settle();
  t.is(fake.changes.length, 3);
  t.deepEqual(fake.changes[2].change, {
    marks: [{ member: a.member, mark }],
    served: [{ session: sessions[1], member: a.member, at: NOW + 200 }],
  });
  t.is(fakeTimers.armed(), 0, 'the flush timer was cancelled');
  // A lifted mark: no `mark` field.
  bridge.record({ marks: [{ member: a.member }] });
  await settle();
  t.deepEqual(fake.changes[3].change, { marks: [{ member: a.member }] });
  t.true(matches(fake.changes[3].change, m4Shapes.PoolChange));
  // flush sends what waits now.
  bridge.record({
    served: [{ session: sessions[2], member: a.member, at: NOW }],
  });
  await bridge.flush();
  await settle();
  t.is(fake.changes.length, 5);
  await bridge.flush();
  await settle();
  t.is(fake.changes.length, 5, 'nothing waits: nothing sent');
});

test('waiting stamps are bounded by the manager’s record count', async t => {
  const fake = makeFakeSink();
  const fakeTimers = makeFakeTimers();
  const bridge = makePoolStateBridge({
    sink: fake.sink,
    backend: Far('Backend', {}),
    timers: fakeTimers.timers,
  });
  const a = member('A');
  for (let index = 0; index < 300; index += 1) {
    bridge.record({
      served: [{ session: Far('Session', {}), member: a.member, at: index }],
    });
  }
  t.is(bridge.pending(), 256);
  fakeTimers.advance(1000);
  await settle();
  t.is(fake.changes.length, 8);
  t.is(fake.changes[0].change.served[0].at, 44, 'oldest dropped');
});

test('core and bridge: one manager delivery per refusal, stamps at most once a minute per session', async t => {
  let clock = NOW;
  const a = member('A');
  const b = member('B');
  const fake = makeFakeSink({
    state: harden({ state: 'active', members: [a, b], served: [] }),
  });
  const fakeTimers = makeFakeTimers();
  const backend = Far('Backend', {});
  const bridge = makePoolStateBridge({
    sink: fake.sink,
    backend,
    timers: fakeTimers.timers,
  });
  const loaded = await bridge.load();
  const core = makePoolCore({
    members: loaded.members,
    readingOf: () => undefined,
    now: () => clock,
    initial: initialFromPoolState(loaded),
    onChange: bridge.record,
  });
  const session = Far('Session', {});
  const ticket = core.forSession(session);
  // A round: A refuses as exhausted, B serves.
  const [first, second] = ticket.select();
  t.is(first, loaded.members[0]);
  ticket.exhausted(first.member, NOW + 3_600_000);
  await settle();
  t.is(fake.changes.length, 1, 'the mark is one delivery, sent at once');
  ticket.served(second.member);
  // 30 more turns over a minute on B: stamps coalesce.
  for (let turn = 0; turn < 30; turn += 1) {
    clock += 2000;
    ticket.served(second.member);
    fakeTimers.advance(2000);
  }
  await settle();
  const servedDeliveries = fake.changes.filter(c => c.change.served).length;
  t.true(servedDeliveries <= 2, `stamps sent ${servedDeliveries} times`);
  t.is(
    fake.changes.filter(c => c.change.marks).length,
    1,
    'serving B lifts nothing',
  );
});
