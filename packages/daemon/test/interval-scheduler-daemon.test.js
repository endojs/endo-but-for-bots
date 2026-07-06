// @ts-nocheck
/* global process, setTimeout */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { start, stop, purge, makeEndoClient } from '../index.js';

// Exercises endoclaw-timer Phase 2 end to end against a real daemon: an
// interval scheduler delivers its ticks as `interval-tick` mail messages
// carrying a `tick-response` capability, and the agent drives the schedule by
// invoking that capability. The scheduler is bound to the host agent, so the
// host's own inbox receives the ticks.

const { raw } = String;

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

// The unix domain socket path has a hard ~104-char limit on many platforms, so
// keep it short and out of the (potentially deep) worktree tree, while the
// bulkier state directories live under the package `tmp/`.
const shortSockPath = tag => {
  const base = process.env.TMPDIR || '/tmp';
  return process.platform === 'win32'
    ? raw`\\?\pipe\endo-${tag}-test.sock`
    : path.join(base, `endo-imt-${tag}.sock`);
};

const makeConfig = (...root) => {
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    sockPath: shortSockPath(root.join('-').replace(/[^a-z0-9]+/gi, '')),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const prepareConfig = async t => {
  const { cancelled, cancel } = makeCancelKit();
  const config = { ...makeConfig('tmp', `interval-mail~${t.context.length}`) };
  await purge(config);
  await start(config);
  const contextObj = { cancel, cancelled, config };
  t.context.push(contextObj);
  return { ...contextObj };
};

const prepareHost = async t => {
  const { cancel, cancelled, config } = await prepareConfig(t);
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  return { cancel, cancelled, config, host: E(bootstrap).host() };
};

/**
 * Advance an inbox iterator until the next `interval-tick` message, returning
 * it. Fails the test if a bounded number of non-tick messages arrive first.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {AsyncIterator<any>} iterator
 */
const takeNextTick = async (t, iterator) => {
  await null;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { value: message, done } = await iterator.next();
    t.false(done, 'inbox stream ended before a tick arrived');
    if (message.type === 'interval-tick') {
      return message;
    }
  }
  throw Error('no interval-tick message arrived');
};

test.beforeEach(t => {
  t.context = [];
});

test.afterEach.always(async t => {
  const configs = t.context;
  await Promise.allSettled(configs.map(({ config }) => stop(config)));
  for (const { cancel, cancelled } of configs) {
    cancelled.catch(() => {});
    cancel(Error('teardown'));
  }
});

test('interval scheduler delivers ticks as mail and resolve advances the schedule', async t => {
  const { host } = await prepareHost(t);

  // The host method resolves to the `{ scheduler, schedulerControl }` facet
  // pair (endoclaw-timer Phase 4); the agent-facing `scheduler` facet carries
  // makeInterval / list.
  const { scheduler } = await E(host).makeIntervalScheduler('scheduler', {
    minPeriodMs: 1000,
  });

  // Follow the host inbox before creating the interval so the immediate first
  // tick is observed.
  const iterator = iterateReader(E(host).followMessages());

  // firstDelayMs 0 → the first tick fires immediately; a generous
  // tickTimeoutMs keeps auto-resolve from racing the manual response.
  await E(scheduler).makeInterval('heartbeat', 1000, {
    firstDelayMs: 0,
    tickTimeoutMs: 60_000,
  });

  const tick1 = await takeNextTick(t, iterator);
  t.is(tick1.type, 'interval-tick', 'tick is delivered as an interval-tick');
  t.is(tick1.label, 'heartbeat');
  t.is(tick1.periodMs, 1000);
  t.is(tick1.tickNumber, 1, 'first tick is number 1');
  t.is(tick1.missedTicks, 0);
  t.is(typeof tick1.intervalId, 'string');
  t.is(
    typeof tick1.tickResponseId,
    'string',
    'tick carries a tick-response capability reference',
  );

  // The tick's persisted message formula must also incarnate through the
  // daemon's `message` maker (makeMessageHub) — a parallel message-type
  // enumeration the followMessages/makeStampedMessage path does not exercise.
  // Looking the message up as a mail sub-hub drives that incarnation; without
  // the interval-tick branch in makeMessageHub it rejects with 'Unknown message
  // type', leaving every persisted tick's controller self-cancelled.
  const tick1Hub = await E(host).lookup(['@mail', String(tick1.number)]);
  const tick1Names = await E(tick1Hub).list();
  t.true(
    tick1Names.includes('@type'),
    'tick message formula incarnates as a mail hub',
  );
  t.true(
    tick1Names.includes('@tickResponse'),
    'the incarnated tick message exposes its tick-response reference',
  );
  t.is(
    await E(tick1Hub).lookup('@label'),
    'heartbeat',
    'the incarnated tick message carries the tick metadata',
  );

  // Resolve the tick through the delivered capability; the schedule advances
  // and the next tick is delivered as another mail message.
  const tickResponse1 = await E(host).lookupByLocator(tick1.tickResponseId);
  await E(tickResponse1).resolve();

  const tick2 = await takeNextTick(t, iterator);
  t.is(tick2.tickNumber, 2, 'resolve() advanced the schedule to the next tick');
  t.is(tick2.intervalId, tick1.intervalId, 'same interval');
  t.not(
    tick2.tickResponseId,
    tick1.tickResponseId,
    'each tick carries a fresh tick-response',
  );

  // Clean up the interval so the scheduler's timers stop before teardown.
  const tickResponse2 = await E(host).lookupByLocator(tick2.tickResponseId);
  await E(tickResponse2).resolve();
});

const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Advance an inbox iterator until an `interval-tick` for the given interval
 * arrives carrying `missedTicks >= 1` — the coalesced catch-up delivered by
 * startup recovery. The pre-restart tick 1 (missedTicks 0) is replayed first
 * on the fresh inbox follow and is skipped.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {AsyncIterator<any>} iterator
 * @param {string} intervalId
 */
const takeCatchUpTick = async (t, iterator, intervalId) => {
  await null;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { value: message, done } = await iterator.next();
    t.false(done, 'inbox stream ended before the catch-up tick arrived');
    if (
      message.type === 'interval-tick' &&
      message.intervalId === intervalId &&
      Number(message.missedTicks) >= 1
    ) {
      return message;
    }
  }
  throw Error('no coalesced catch-up interval-tick arrived after restart');
};

// Exercises endoclaw-timer Phase 3 (startup recovery) end to end against a
// REAL daemon restart. A scheduler with an active interval is created and its
// first tick observed, then the daemon is stopped with the interval's next
// fire time left in the past. After a downtime gap, the SAME state directory is
// restarted: on startup the daemon eagerly incarnates the persisted
// interval-scheduler, which re-arms the interval and delivers a single
// coalesced catch-up `interval-tick` carrying missedTicks > 0. Crucially, the
// second incarnation never looks the scheduler up — the catch-up tick proves
// recovery ran from `seedFormulaGraphFromPersistence`, not from a lazy lookup.
test('startup recovery re-arms intervals and delivers a coalesced catch-up tick after a daemon restart', async t => {
  // Bound the wait: if startup recovery does not incarnate the scheduler, the
  // catch-up tick never arrives and this fails crisply instead of hanging.
  t.timeout(30_000);
  const config = {
    ...makeConfig('tmp', `interval-recovery~${t.context.length}`),
  };
  await purge(config);

  // ── First incarnation: create the scheduler + interval, observe tick 1. ──
  await start(config);
  const first = makeCancelKit();
  first.cancelled.catch(() => {});
  const client1 = await makeEndoClient(
    'client',
    config.sockPath,
    first.cancelled,
  );
  client1.closed.catch(() => {});
  const host1 = E(client1.getBootstrap()).host();

  const { scheduler } = await E(host1).makeIntervalScheduler('scheduler', {
    minPeriodMs: 1000,
  });

  const iterator1 = iterateReader(E(host1).followMessages());
  // A generous tickTimeoutMs keeps auto-resolve from advancing the schedule
  // while we hold the tick unresolved across the restart.
  await E(scheduler).makeInterval('heartbeat', 1000, {
    firstDelayMs: 0,
    tickTimeoutMs: 60_000,
  });

  const tick1 = await takeNextTick(t, iterator1);
  t.is(tick1.tickNumber, 1, 'pre-restart tick is number 1');
  t.is(tick1.missedTicks, 0, 'no ticks missed before any downtime');
  const { intervalId } = tick1;
  t.is(typeof intervalId, 'string');

  // Leave the tick unresolved: the persisted entry's nextTickAt stays in the
  // (soon-to-be) past so the restart sees missed ticks to coalesce.
  first.cancel(Error('restart'));
  await stop(config);

  // ── Downtime. The gap exceeds the 1s period, so at least one tick is
  // missed and the recovery math coalesces it into a single catch-up. ──
  await delay(2000);

  // ── Second incarnation (restart) against the SAME state directory. ──
  await start(config);
  const second = makeCancelKit();
  second.cancelled.catch(() => {});
  // Registered for teardown by afterEach.always (stops the restarted daemon
  // and cancels this client).
  t.context.push({
    config,
    cancel: second.cancel,
    cancelled: second.cancelled,
  });
  const client2 = await makeEndoClient(
    'client2',
    config.sockPath,
    second.cancelled,
  );
  client2.closed.catch(() => {});
  const host2 = E(client2.getBootstrap()).host();

  // Follow the host inbox WITHOUT ever looking up the scheduler on this
  // incarnation. The catch-up tick can only appear if startup recovery
  // eagerly incarnated the scheduler and delivered it.
  const iterator2 = iterateReader(E(host2).followMessages());
  const catchUp = await takeCatchUpTick(t, iterator2, intervalId);
  t.is(catchUp.type, 'interval-tick');
  t.is(
    catchUp.intervalId,
    intervalId,
    'same interval recovered across restart',
  );
  t.true(
    Number(catchUp.missedTicks) >= 1,
    'downtime is coalesced into a single catch-up with missedTicks > 0',
  );
  t.is(
    catchUp.tickNumber,
    2,
    'recovery advances the interval to its next tick number, not a replay storm',
  );

  // Resolve the catch-up so the re-armed timer stops before teardown.
  const catchUpResponse = await E(host2).lookupByLocator(
    catchUp.tickResponseId,
  );
  await E(catchUpResponse).resolve();
});
