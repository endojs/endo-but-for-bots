// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { passStyleOf } from '@endo/pass-style';
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
    onTick: message => {
      ticks.push(message);
    },
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

test('each tick delivers a TickResponse guarded exo', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/exo',
    makeId,
    onTick: message => {
      ticks.push(message);
    },
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await scheduler.makeInterval('heartbeat', 10_000);
  await clock.advance(0);
  t.is(ticks.length, 1);

  const { tickResponse } = ticks[0];
  // A proper exo, not a bare record: it is a remotable with guarded methods,
  // so unguarded / unknown method calls are rejected rather than silently
  // accepted. (Regression guard for the Phase-2 `M.interface()` requirement —
  // a plain `harden({ ... })` record would report passStyle 'copyRecord'.)
  t.is(passStyleOf(/** @type {any} */ (tickResponse)), 'remotable');
  t.throws(() => /** @type {any} */ (tickResponse).frobnicate(), {
    message: /frobnicate/,
  });
  t.is(tickResponse.resolve(), undefined);
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
    onTick: message => {
      ticks.push(message);
    },
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
    onTick: message => {
      ticks.push(message);
    },
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
  first.stop();

  // Jump forward well past several periods of downtime.
  await clock.advance(35_000);

  // Second incarnation recovers from the same persisted directory.
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const second = await makeIntervalScheduler({
    filePowers,
    persistDir,
    makeId,
    onTick: message => {
      ticks.push(message);
    },
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  const recovered = await second.scheduler.list();
  t.is(recovered.length, 1, 'the active interval is recovered');
  t.is(recovered[0].label, 'heartbeat');

  // A single coalesced catch-up tick is delivered for the missed periods.
  // nextTickAt was 1_010_000 at shutdown; recovery at 1_035_000 missed exactly
  // floor((1_035_000 - 1_010_000) / 10_000) = 2 periods.
  t.is(ticks.length, 1);
  t.is(ticks[0].missedTicks, 2, 'exact coalesced missed-tick count');

  // Recovery re-arms the schedule: the next real tick fires one period after
  // the catch-up boundary (1_040_000), proving the interval keeps ticking.
  await clock.advance(5000);
  t.is(ticks.length, 2, 'a subsequent tick fires after recovery re-arm');
  t.is(ticks[1].missedTicks, 0);
});

test('reschedule redelivers the same tick, holds the deadline fixed, and gives up without drift', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/reschedule',
    makeId,
    onTick: message => {
      ticks.push(message);
    },
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  // period 10_000 → tickTimeoutMs default 5000, baseBackoff min(1000, 1000)=1000.
  await scheduler.makeInterval('retry', 10_000);
  await clock.advance(0);
  t.is(ticks.length, 1);
  t.is(ticks[0].tickNumber, 1);
  const originalScheduledAt = ticks[0].scheduledAt;

  // reschedule #1 (backoff 1000ms): the SAME tick number is redelivered.
  ticks[0].tickResponse.reschedule();
  await clock.advance(1000);
  t.is(ticks.length, 2);
  t.is(ticks[1].tickNumber, 1, 'reschedule redelivers the same tick number');
  t.is(
    ticks[1].scheduledAt,
    originalScheduledAt,
    'scheduled time does not drift across a reschedule',
  );

  // A second reschedule() on the FIRST (already-consumed) response is a no-op:
  // one-shot responses cannot orphan a second retry timer.
  ticks[0].tickResponse.reschedule();
  await clock.advance(0);
  t.is(ticks.length, 2, 'a stale response cannot trigger another retry');

  // reschedule #2 (backoff 2000ms) then #3, which exceeds the fixed deadline
  // (originalScheduledAt + tickTimeoutMs) and gives up → the tick resolves and
  // the schedule advances to the next period boundary rather than looping.
  ticks[1].tickResponse.reschedule();
  await clock.advance(2000);
  t.is(ticks.length, 3);
  t.is(ticks[2].tickNumber, 1);
  ticks[2].tickResponse.reschedule(); // retryAt now >= deadline → give up

  // The next delivery is a fresh tick (number 2) exactly one period after the
  // original — no forward drift accumulated from the three retries.
  await clock.advance(10_000);
  t.is(ticks.length, 4);
  t.is(ticks[3].tickNumber, 2, 'a bounded retry budget resumes normal ticking');
  t.is(
    ticks[3].scheduledAt,
    originalScheduledAt + 10_000,
    'exactly one period elapsed despite the retries (no drift)',
  );
});

test('a tick with no response auto-resolves at its deadline and the schedule continues', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/deadline',
    makeId,
    // Never respond — exercise the tick-timeout auto-resolve path.
    onTick: message => {
      ticks.push(message);
    },
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await scheduler.makeInterval('unanswered', 10_000); // tickTimeoutMs = 5000
  await clock.advance(0);
  t.is(ticks.length, 1);

  // Before the deadline, no further tick.
  await clock.advance(4999);
  t.is(ticks.length, 1);

  // At the 5000ms deadline the tick auto-resolves; one period later the next
  // tick arms and fires — the interval is not wedged by an unanswered tick.
  await clock.advance(1); // deadline fires (auto-resolve)
  await clock.advance(10_000);
  t.is(ticks.length, 2, 'the next tick fires after the deadline auto-resolve');
  t.is(ticks[1].tickNumber, 2);

  // A stale response on the already-timed-out tick 1 — via resolve() OR
  // reschedule() — is inert: the deadline auto-resolve consumed that response's
  // one-shot latch, so a stashed response cannot re-enter and force a duplicate
  // tick keyed to the current tick number.
  const beforeStale = ticks.length;
  ticks[0].tickResponse.reschedule();
  ticks[0].tickResponse.resolve();
  await clock.advance(0);
  t.is(
    ticks.length,
    beforeStale,
    'a stale timed-out response cannot inject a tick',
  );
});

test('stop() is permanent: a late tickResponse cannot resurrect a cancelled scheduler', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  /** @type {import('../src/types.js').IntervalTickMessage[]} */
  const ticks = [];
  const { scheduler, stop } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/stop',
    makeId,
    onTick: message => {
      ticks.push(message);
    },
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  await scheduler.makeInterval('beat', 10_000);
  await clock.advance(0);
  t.is(ticks.length, 1);

  // The daemon cancels the formula (GC). stop() disarms and revokes.
  stop();

  // An agent still holding the delivered tickResponse resolves it after
  // cancellation — this must NOT re-arm a live timer.
  ticks[0].tickResponse.resolve();
  await clock.advance(60_000);
  t.is(ticks.length, 1, 'no ticks fire after stop(), even on a late resolve()');
});

test('initial limits and interval options are validated', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  const base = {
    filePowers,
    persistDir: '/state/validate',
    makeId,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  };

  // A maxActive of 0 would otherwise brick the scheduler (0 >= 0 always true).
  await t.throwsAsync(
    () => makeIntervalScheduler({ ...base, maxActive: 0 }),
    { message: /maxActive must be between/ },
    'maxActive below 1 is rejected at construction',
  );
  await t.throwsAsync(
    () => makeIntervalScheduler({ ...base, minPeriodMs: 500 }),
    { message: /minPeriodMs must be between/ },
    'minPeriodMs below the absolute floor is rejected at construction',
  );

  const { scheduler } = await makeIntervalScheduler({
    ...base,
    minPeriodMs: 1000,
  });
  await t.throwsAsync(
    () => scheduler.makeInterval('bad-delay', 10_000, { firstDelayMs: -1 }),
    { message: /firstDelayMs must be/ },
  );
  await t.throwsAsync(
    () => scheduler.makeInterval('bad-timeout', 10_000, { tickTimeoutMs: 0 }),
    { message: /tickTimeoutMs must be/ },
  );
});

test('control setters enforce the ceiling and floor', async t => {
  const { filePowers } = makeFakeFilePowers();
  const clock = makeFakeClock();
  const { schedulerControl } = await makeIntervalScheduler({
    filePowers,
    persistDir: '/state/setters',
    makeId,
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });

  t.throws(() => schedulerControl.setMaxActive(MAX_ACTIVE_CEILING + 1), {
    message: /between 1 and/,
  });
  t.throws(() => schedulerControl.setMaxActive(0), {
    message: /between 1 and/,
  });
  t.throws(() => schedulerControl.setMinPeriodMs(500), { message: /between/ });
});

test('a corrupt persisted entry is skipped, not fatal, during recovery', async t => {
  const persistDir = '/state/corrupt';
  const { filePowers, files } = makeFakeFilePowers();
  const clock = makeFakeClock();

  const first = await makeIntervalScheduler({
    filePowers,
    persistDir,
    makeId,
    minPeriodMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  await first.scheduler.makeInterval('good', 10_000);
  first.stop();

  // Simulate a truncated/corrupt entry file alongside the valid one.
  files.set(`${persistDir}/corrupt.json`, '{ this is not valid json');

  // Recovery must not throw; it skips the corrupt file and recovers the good
  // interval (crash-safe persistence).
  const second = await makeIntervalScheduler({
    filePowers,
    persistDir,
    minPeriodMs: 1000,
    makeId,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  const recovered = await second.scheduler.list();
  t.is(recovered.length, 1, 'the valid interval survives a corrupt sibling');
  t.is(recovered[0].label, 'good');
});

test('exported constants match the design defaults', t => {
  t.is(DEFAULT_MIN_PERIOD_MS, 30_000);
  t.is(MAX_ACTIVE_CEILING, 100);
});
