// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeIntervalScheduler,
  DEFAULT_MIN_PERIOD_MS,
  MAX_ACTIVE_CEILING,
} from '../src/interval-scheduler.js';

/**
 * An in-memory stand-in for the daemon's `filePowers`, exposing just the
 * methods the interval scheduler uses. Files live in a flat map keyed by their
 * full path; `readDirectory` returns the basenames whose directory matches.
 */
const makeFakeFilePowers = () => {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  const joinPath = (...parts) => parts.join('/');
  const dirname = path => path.slice(0, path.lastIndexOf('/'));
  const basename = path => path.slice(path.lastIndexOf('/') + 1);
  return {
    files,
    filePowers: {
      joinPath,
      makePath: async path => {
        dirs.add(path);
      },
      writeFileText: async (path, text) => {
        files.set(path, text);
        dirs.add(dirname(path));
      },
      renamePath: async (source, target) => {
        const text = files.get(source);
        files.delete(source);
        if (text !== undefined) {
          files.set(target, text);
        }
      },
      readDirectory: async dir => {
        if (!dirs.has(dir)) {
          const error = new Error(`ENOENT: no such directory ${dir}`);
          /** @type {any} */ (error).code = 'ENOENT';
          throw error;
        }
        return [...files.keys()]
          .filter(path => dirname(path) === dir)
          .map(basename);
      },
      maybeReadFileText: async path => files.get(path),
      removePath: async path => {
        files.delete(path);
      },
    },
  };
};

/**
 * A deterministic clock + timer queue. `advance(ms)` steps the clock forward,
 * firing due timers in order and draining microtasks between each fire so
 * async tick handlers settle.
 */
const makeFakeClock = () => {
  let clock = 1_000_000;
  let nextId = 1;
  /** @type {Map<number, { fireAt: number, callback: () => void }>} */
  const timers = new Map();
  const drainMicrotasks = async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
  };
  return {
    now: () => clock,
    /**
     * @param {() => void} callback
     * @param {number} ms
     */
    setTimeout: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: clock + Math.max(0, ms), callback });
      return id;
    },
    /** @param {unknown} id */
    clearTimeout: id => {
      timers.delete(/** @type {number} */ (id));
    },
    /** @param {number} ms */
    advance: async ms => {
      const target = clock + ms;
      for (;;) {
        /** @type {{ fireAt: number, callback: () => void } | undefined} */
        let earliest;
        let earliestId = 0;
        for (const [id, timer] of timers) {
          if (timer.fireAt <= target) {
            if (earliest === undefined || timer.fireAt < earliest.fireAt) {
              earliest = timer;
              earliestId = id;
            }
          }
        }
        if (earliest === undefined) {
          break;
        }
        clock = earliest.fireAt;
        timers.delete(earliestId);
        earliest.callback();
        // eslint-disable-next-line no-await-in-loop
        await drainMicrotasks();
      }
      clock = target;
      await drainMicrotasks();
    },
  };
};

let idCounter = 0;
const makeId = async () => {
  idCounter += 1;
  return `id${idCounter.toString(16).padStart(8, '0')}`;
};

test('makeInterval creates, persists, lists, and fires ticks', async t => {
  const { filePowers, files } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/intervals',
    makeId,
    onTick: message => ticks.push(message),
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  const interval = await scheduler.makeInterval('heartbeat', 10_000);
  t.is(interval.label(), 'heartbeat');
  t.is(interval.period(), 10_000);

  const listed = await scheduler.list();
  t.is(listed.length, 1);
  t.is(listed[0].label, 'heartbeat');
  t.is(listed[0].status, 'active');

  // The entry was persisted to disk.
  const persisted = [...files.keys()].filter(p => p.endsWith('.json'));
  t.is(persisted.length, 1);

  // First tick fires immediately (firstDelayMs default 0), then the agent
  // resolves and the next tick fires one period later.
  await clock.advance(0);
  t.is(ticks.length, 1);
  t.is(ticks[0].tickNumber, 1);
  t.is(ticks[0].missedTicks, 0);
  ticks[0].tickResponse.resolve();
  await clock.advance(10_000);
  t.is(ticks.length, 2);
  t.is(ticks[1].tickNumber, 2);
});

test('makeInterval enforces minPeriodMs and maxActive', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  const { scheduler, schedulerControl } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/limits',
    makeId,
    minPeriodMs: 5000,
    maxActive: 2,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await t.throwsAsync(() => scheduler.makeInterval('too-fast', 1000), {
    message: /below the minimum/,
  });

  await scheduler.makeInterval('a', 5000);
  await scheduler.makeInterval('b', 5000);
  await t.throwsAsync(() => scheduler.makeInterval('c', 5000), {
    message: /active interval limit reached/,
  });

  // Raising the limit via control allows another.
  schedulerControl.setMaxActive(3);
  const c = await scheduler.makeInterval('c', 5000);
  t.is(c.label(), 'c');
});

test('cancel disarms and marks the interval cancelled', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/cancel',
    makeId,
    onTick: message => ticks.push(message),
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  const interval = await scheduler.makeInterval('gone', 10_000, {
    firstDelayMs: 10_000,
  });
  await interval.cancel();
  t.is(interval.info().status, 'cancelled');

  const listed = await scheduler.list();
  t.is(listed.length, 0, 'cancelled intervals are not listed');

  // No ticks fire after cancellation.
  await clock.advance(30_000);
  t.is(ticks.length, 0);
});

test('pause suppresses ticks; resume re-arms', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler, schedulerControl } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/pause',
    makeId,
    onTick: message => ticks.push(message),
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await scheduler.makeInterval('beat', 10_000, { firstDelayMs: 10_000 });
  schedulerControl.pause();
  await clock.advance(30_000);
  t.is(ticks.length, 0, 'no ticks while paused');

  schedulerControl.resume();
  await clock.advance(0);
  t.is(ticks.length, 1, 'resume re-arms and the overdue tick fires');
});

test('revoke is permanent and blocks further use', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  const { scheduler, schedulerControl } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/revoke',
    makeId,
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await scheduler.makeInterval('a', 5000);
  await schedulerControl.revoke();

  await t.throwsAsync(() => scheduler.makeInterval('b', 5000), {
    message: /revoked/,
  });
  await t.throwsAsync(() => scheduler.list(), { message: /revoked/ });

  const all = await schedulerControl.listAll();
  t.true(all.every(e => e.status === 'cancelled'));
});

test('startup recovery re-arms active intervals and coalesces missed ticks', async t => {
  const persistDir = '/state/recover';
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();

  // First incarnation: create an interval, resolve its immediate tick so the
  // next tick is scheduled one period out, then simulate a shutdown.
  const first = await makeIntervalScheduler({
    filePowers,
    persistDir,
    makeId,
    onTick: message => message.tickResponse.resolve(),
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  await first.scheduler.makeInterval('heartbeat', 10_000);
  await clock.advance(0); // fire + resolve the immediate tick
  first.disarmAll();

  // Jump forward well past several periods of downtime.
  await clock.advance(35_000);

  // Second incarnation recovers from the same persisted directory.
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const second = await makeIntervalScheduler({
    filePowers,
    persistDir,
    makeId,
    onTick: message => ticks.push(message),
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  const recovered = await second.scheduler.list();
  t.is(recovered.length, 1, 'the active interval is recovered');
  t.is(recovered[0].label, 'heartbeat');

  // A single coalesced catch-up tick is delivered for the missed periods.
  t.is(ticks.length, 1);
  t.true(ticks[0].missedTicks >= 1, 'missed ticks are reported');
});

test('exported constants match the design defaults', t => {
  t.is(DEFAULT_MIN_PERIOD_MS, 30_000);
  t.is(MAX_ACTIVE_CEILING, 100);
});
