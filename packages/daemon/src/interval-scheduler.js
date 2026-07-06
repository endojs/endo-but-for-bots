// @ts-check
/* global setTimeout, clearTimeout */

/**
 * @module interval-scheduler
 *
 * EndoClaw interval scheduler — core heartbeat scheduling facility, graduated
 * from the `@endo/genie` prototype (`packages/genie/src/interval/`) into the
 * daemon so it can be incarnated as a proper `interval-scheduler` formula.
 *
 * The scheduler delivers start-to-start interval "ticks" with
 * resolve/reschedule semantics, exponential backoff, host-controlled limits,
 * and crash-safe persistence. Compared to the genie prototype this port:
 *
 * - persists through the daemon's `filePowers` (write-then-rename) rather than
 *   importing `node:fs` directly, so it works inside the SES-locked daemon;
 * - takes an injected id generator (the daemon's `randomHex256`) instead of
 *   `node:crypto`;
 * - takes injectable `setTimeout`/`clearTimeout`/`now` so tests can drive a
 *   deterministic clock.
 *
 * Tick delivery is still through the injected `onTick` callback. Delivering
 * ticks as daemon mail messages (with a `TickResponse` exo) is Phase 2 of the
 * endoclaw-timer design and is intentionally left to the caller's `onTick`.
 */

import { Far } from '@endo/pass-style';

/** @import { IntervalEntry, IntervalSchedulerPowers, IntervalSchedulerExo } from './types.js' */

const { isFinite } = Number;

/** Default maximum number of active intervals per scheduler. */
export const DEFAULT_MAX_ACTIVE = 5;

/** Default minimum period in milliseconds. */
export const DEFAULT_MIN_PERIOD_MS = 30_000;

/** Absolute minimum period floor (1 second). */
export const ABSOLUTE_MIN_PERIOD_MS = 1000;

/** Maximum allowed active intervals. */
export const MAX_ACTIVE_CEILING = 100;

/** Maximum allowed period (24 hours). */
export const MAX_PERIOD_MS = 86_400_000;

/**
 * Atomically write a JSON entry using write-then-rename, mirroring the
 * content-store pattern already used elsewhere in the daemon.
 *
 * @param {import('./types.js').IntervalSchedulerFilePowers} filePowers
 * @param {() => Promise<string>} makeId
 * @param {string} dir
 * @param {string} fileName
 * @param {unknown} value
 */
const atomicWriteJSON = async (filePowers, makeId, dir, fileName, value) => {
  const suffix = await makeId();
  const temporaryPath = filePowers.joinPath(dir, `.tmp.${suffix}`);
  const finalPath = filePowers.joinPath(dir, fileName);
  await filePowers.writeFileText(temporaryPath, `${JSON.stringify(value)}\n`);
  await filePowers.renamePath(temporaryPath, finalPath);
};

/**
 * Read all persisted interval entries from a scheduler's directory.
 *
 * @param {import('./types.js').IntervalSchedulerFilePowers} filePowers
 * @param {string} dir
 * @returns {Promise<IntervalEntry[]>}
 */
const readAllEntries = async (filePowers, dir) => {
  await null;
  /** @type {IntervalEntry[]} */
  const entries = [];
  let files;
  try {
    files = await filePowers.readDirectory(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return entries;
    }
    throw error;
  }
  for (const file of files) {
    if (file.endsWith('.json') && !file.startsWith('.tmp.')) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await filePowers.maybeReadFileText(
        filePowers.joinPath(dir, file),
      );
      if (raw !== undefined) {
        entries.push(JSON.parse(raw));
      }
    }
  }
  return entries;
};

/**
 * Create an interval scheduler capability pair. Returns
 * `{ scheduler, schedulerControl }` — the scheduler facet is granted to the
 * agent, while the control facet is retained by the host.
 *
 * @param {IntervalSchedulerPowers} powers
 * @returns {Promise<IntervalSchedulerExo>}
 */
export const makeIntervalScheduler = async powers => {
  const {
    filePowers,
    persistDir,
    makeId,
    onTick,
    maxActive: initialMaxActive = DEFAULT_MAX_ACTIVE,
    minPeriodMs: initialMinPeriodMs = DEFAULT_MIN_PERIOD_MS,
    paused: initialPaused = false,
    setTimeout: setTimer = /** @type {(cb: () => void, ms: number) => unknown} */ (
      setTimeout
    ),
    clearTimeout: clearTimer = /** @type {(handle: unknown) => void} */ (
      clearTimeout
    ),
    now = () => Date.now(),
  } = powers;

  // ── Mutable state ───────────────────────────────────────────────
  let maxActive = initialMaxActive;
  let minPeriodMs = initialMinPeriodMs;
  let paused = initialPaused;
  let revoked = false;

  /** @type {Map<string, IntervalEntry>} In-memory cache of entries. */
  const entries = new Map();
  /** @type {Map<string, unknown>} Active tick timeouts (opaque timer handles). */
  const activeTimeouts = new Map();
  /** @type {Map<string, unknown>} Active tick-deadline timeouts. */
  const tickDeadlines = new Map();
  /** @type {Map<string, number>} Per-tick reschedule counters keyed by `${id}:${tickCount}`. */
  const rescheduleCounts = new Map();
  /** @type {Map<string, boolean>} Tracks whether a tick response has been consumed. */
  const tickResponseConsumed = new Map();

  const intervalsDir = persistDir;

  /**
   * Persist an entry to disk if a persist directory is configured.
   *
   * @param {IntervalEntry} entry
   */
  const persist = async entry => {
    await null;
    if (intervalsDir !== undefined) {
      await atomicWriteJSON(
        filePowers,
        makeId,
        intervalsDir,
        `${entry.id}.json`,
        entry,
      );
    }
  };

  // Forward declarations for the mutually-recursive tick lifecycle.
  /** @type {(entryId: string) => Promise<void>} */
  let onIntervalTick;
  /** @type {(entry: IntervalEntry) => void} */
  let onTickResolved;
  /** @type {(entry: IntervalEntry, rescheduleCount: number) => void} */
  let onTickRescheduled;

  /**
   * Disarm all timeouts for a given entry.
   *
   * @param {string} entryId
   */
  const disarmInterval = entryId => {
    const handle = activeTimeouts.get(entryId);
    if (handle !== undefined) {
      clearTimer(handle);
      activeTimeouts.delete(entryId);
    }
    const deadlineHandle = tickDeadlines.get(entryId);
    if (deadlineHandle !== undefined) {
      clearTimer(deadlineHandle);
      tickDeadlines.delete(entryId);
    }
  };

  /** Disarm every interval. */
  const disarmAll = () => {
    for (const [id] of activeTimeouts) {
      disarmInterval(id);
    }
    for (const [, handle] of tickDeadlines) {
      clearTimer(handle);
    }
    tickDeadlines.clear();
  };

  /**
   * Arm (or re-arm) a timer for the given entry.
   *
   * @param {IntervalEntry} entry
   */
  const armInterval = entry => {
    disarmInterval(entry.id);
    if (entry.status !== 'active' || paused || revoked) {
      return;
    }
    const delayMs = Math.max(0, entry.nextTickAt - now());
    const handle = setTimer(() => {
      onIntervalTick(entry.id).catch(error =>
        console.error(
          `[interval-scheduler] tick error for ${entry.label}:`,
          error,
        ),
      );
    }, delayMs);
    activeTimeouts.set(entry.id, handle);
  };

  /**
   * Build and deliver an `interval-tick` message for the given entry, arming
   * the per-tick deadline timeout.
   *
   * @param {IntervalEntry} entry
   * @param {number} actualAt - actual fire time
   * @param {number} [missedTicks]
   */
  const deliverTick = (entry, actualAt, missedTicks = 0) => {
    const tickKey = `${entry.id}:${entry.tickCount}`;

    // One-shot TickResponse capability. Phase 2 replaces this plain record
    // with a daemon-formulated TickResponse exo delivered by mail.
    const tickResponse = harden({
      resolve() {
        if (tickResponseConsumed.get(tickKey)) {
          return;
        }
        tickResponseConsumed.set(tickKey, true);
        onTickResolved(entry);
      },
      reschedule() {
        if (tickResponseConsumed.get(tickKey)) {
          return;
        }
        const count = (rescheduleCounts.get(tickKey) || 0) + 1;
        rescheduleCounts.set(tickKey, count);
        onTickRescheduled(entry, count);
      },
    });

    const message = harden({
      type: /** @type {const} */ ('interval-tick'),
      intervalId: entry.id,
      label: entry.label,
      periodMs: entry.periodMs,
      tickNumber: entry.tickCount,
      scheduledAt: entry.nextTickAt - entry.periodMs,
      actualAt,
      missedTicks,
      tickResponse,
    });

    // Arm the tick-deadline timeout (auto-resolve on no response).
    const deadlineHandle = setTimer(() => {
      if (!tickResponseConsumed.get(tickKey)) {
        tickResponseConsumed.set(tickKey, true);
        console.warn(
          `Interval ${entry.label} tick ${entry.tickCount} timed out after ${entry.tickTimeoutMs}ms`,
        );
        onTickResolved(entry);
      }
    }, entry.tickTimeoutMs);
    tickDeadlines.set(entry.id, deadlineHandle);

    if (onTick !== undefined) {
      try {
        onTick(message);
      } catch (error) {
        console.error(
          `[interval-scheduler] onTick callback error for ${entry.label}:`,
          error,
        );
      }
    }
  };

  onIntervalTick = async entryId => {
    const entry = entries.get(entryId);
    if (!entry || entry.status !== 'active' || paused || revoked) {
      return;
    }
    const actualAt = now();
    entry.tickCount += 1;
    // Advance nextTickAt to the next period boundary (start-to-start).
    const scheduledAt = entry.nextTickAt;
    entry.nextTickAt = scheduledAt + entry.periodMs;
    await persist(entry);
    deliverTick(entry, actualAt);
  };

  onTickResolved = entry => {
    const deadlineHandle = tickDeadlines.get(entry.id);
    if (deadlineHandle !== undefined) {
      clearTimer(deadlineHandle);
      tickDeadlines.delete(entry.id);
    }
    const tickKey = `${entry.id}:${entry.tickCount}`;
    rescheduleCounts.delete(tickKey);
    // If nextTickAt is already past, this arms immediately.
    armInterval(entry);
    persist(entry).catch(error =>
      console.error(
        `[interval-scheduler] failed to persist entry ${entry.label}:`,
        error,
      ),
    );
  };

  onTickRescheduled = (entry, rescheduleCount) => {
    const deadlineHandle = tickDeadlines.get(entry.id);
    if (deadlineHandle !== undefined) {
      clearTimer(deadlineHandle);
      tickDeadlines.delete(entry.id);
    }
    const baseBackoff = Math.min(1000, entry.periodMs / 10);
    const backoffDelay = Math.min(
      baseBackoff * 2 ** (rescheduleCount - 1),
      entry.tickTimeoutMs,
    );
    const retryAt = now() + backoffDelay;
    // The deadline is measured from the original scheduled time.
    const deadline = entry.nextTickAt - entry.periodMs + entry.tickTimeoutMs;
    if (retryAt >= deadline) {
      onTickResolved(entry);
      return;
    }
    // Re-arm — reuse onIntervalTick, which re-delivers with the same
    // tickNumber (we decrement so the increment nets out).
    entry.tickCount -= 1;
    const handle = setTimer(() => {
      onIntervalTick(entry.id).catch(error =>
        console.error(
          `[interval-scheduler] retry error for ${entry.label}:`,
          error,
        ),
      );
    }, backoffDelay);
    activeTimeouts.set(entry.id, handle);
  };

  // ── Startup recovery ────────────────────────────────────────────
  const recover = async () => {
    if (intervalsDir === undefined) {
      return;
    }
    await filePowers.makePath(intervalsDir);
    const diskEntries = await readAllEntries(filePowers, intervalsDir);
    const currentTime = now();
    for (const entry of diskEntries) {
      entries.set(entry.id, entry);
      // Only active entries are (re-)armed; when paused, entries remain active
      // on disk but stay unarmed until resume().
      if (entry.status === 'active' && !paused) {
        if (entry.nextTickAt <= currentTime) {
          const missedTicks = Math.max(
            0,
            Math.floor((currentTime - entry.nextTickAt) / entry.periodMs),
          );
          entry.nextTickAt += (missedTicks + 1) * entry.periodMs;
          entry.tickCount += 1;
          // eslint-disable-next-line no-await-in-loop
          await persist(entry);
          deliverTick(entry, currentTime, missedTicks);
        }
        armInterval(entry);
      }
    }
  };

  // ── Validation helpers ──────────────────────────────────────────
  /** @param {string} ctx */
  const assertNotRevoked = ctx => {
    if (revoked) {
      throw Error(`Interval scheduler has been revoked (in ${ctx})`);
    }
  };

  /**
   * @param {number} periodMs
   * @param {string} ctx
   */
  const assertValidPeriod = (periodMs, ctx) => {
    if (typeof periodMs !== 'number' || !isFinite(periodMs)) {
      throw TypeError(`${ctx}: periodMs must be a finite number`);
    }
    if (periodMs < minPeriodMs) {
      throw RangeError(
        `${ctx}: periodMs ${periodMs} is below the minimum of ${minPeriodMs}ms`,
      );
    }
    if (periodMs > MAX_PERIOD_MS) {
      throw RangeError(
        `${ctx}: periodMs ${periodMs} exceeds maximum of ${MAX_PERIOD_MS}ms`,
      );
    }
  };

  /**
   * @param {IntervalEntry} entry
   */
  const makeIntervalHandle = entry =>
    Far('Interval', {
      label: () => entry.label,
      period: () => entry.periodMs,
      async setPeriod(periodMs) {
        assertNotRevoked('Interval.setPeriod');
        assertValidPeriod(periodMs, 'Interval.setPeriod');
        entry.periodMs = periodMs;
        entry.tickTimeoutMs = periodMs / 2;
        await persist(entry);
        if (entry.status === 'active') {
          armInterval(entry);
        }
      },
      async cancel() {
        if (entry.status === 'cancelled') {
          return;
        }
        disarmInterval(entry.id);
        entry.status = 'cancelled';
        await persist(entry);
      },
      info: () => harden({ ...entry }),
      help: () =>
        `Interval "${entry.label}" (${entry.periodMs}ms period, status: ${entry.status})`,
    });

  // ── Scheduler facet (agent-facing) ──────────────────────────────
  const scheduler = Far('IntervalScheduler', {
    /**
     * @param {string} label
     * @param {number} periodMs
     * @param {{ firstDelayMs?: number, tickTimeoutMs?: number }} [opts]
     */
    async makeInterval(label, periodMs, opts = {}) {
      assertNotRevoked('makeInterval');
      assertValidPeriod(periodMs, 'makeInterval');
      if (typeof label !== 'string' || label.length === 0) {
        throw TypeError('makeInterval: label must be a non-empty string');
      }
      const activeCount = [...entries.values()].filter(
        e => e.status === 'active',
      ).length;
      if (activeCount >= maxActive) {
        throw Error(
          `makeInterval: active interval limit reached (${maxActive})`,
        );
      }
      const { firstDelayMs = 0, tickTimeoutMs = periodMs / 2 } = opts;
      const createdAt = now();
      const id = await makeId();
      /** @type {IntervalEntry} */
      const entry = {
        id,
        label,
        periodMs,
        firstDelayMs,
        tickTimeoutMs,
        nextTickAt: createdAt + firstDelayMs,
        createdAt,
        tickCount: 0,
        status: 'active',
      };
      entries.set(id, entry);
      if (intervalsDir !== undefined) {
        await filePowers.makePath(intervalsDir);
      }
      await persist(entry);
      armInterval(entry);
      return makeIntervalHandle(entry);
    },

    async list() {
      assertNotRevoked('list');
      return harden(
        [...entries.values()]
          .filter(e => e.status !== 'cancelled')
          .map(e => harden({ ...e })),
      );
    },

    help: () =>
      [
        'IntervalScheduler — create and manage periodic wakeup intervals.',
        '',
        '  makeInterval(label, periodMs, opts?) → Interval',
        '    Create a new interval that fires every periodMs milliseconds.',
        '    opts.firstDelayMs  — delay before first tick (default 0)',
        '    opts.tickTimeoutMs — deadline per tick (default periodMs/2)',
        '',
        '  list() → IntervalEntry[]',
        '    List all non-cancelled intervals.',
        '',
        `  Limits: maxActive=${maxActive}, minPeriodMs=${minPeriodMs}`,
      ].join('\n'),
  });

  // ── Control facet (host-facing) ─────────────────────────────────
  const schedulerControl = Far('IntervalControl', {
    /** @param {number} n */
    setMaxActive(n) {
      if (typeof n !== 'number' || n < 1 || n > MAX_ACTIVE_CEILING) {
        throw RangeError(
          `setMaxActive: n must be between 1 and ${MAX_ACTIVE_CEILING}`,
        );
      }
      maxActive = n;
    },

    /** @param {number} ms */
    setMinPeriodMs(ms) {
      if (
        typeof ms !== 'number' ||
        ms < ABSOLUTE_MIN_PERIOD_MS ||
        ms > MAX_PERIOD_MS
      ) {
        throw RangeError(
          `setMinPeriodMs: ms must be between ${ABSOLUTE_MIN_PERIOD_MS} and ${MAX_PERIOD_MS}`,
        );
      }
      minPeriodMs = ms;
    },

    pause() {
      if (paused) {
        return;
      }
      paused = true;
      disarmAll();
    },

    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      const currentTime = now();
      for (const entry of entries.values()) {
        if (entry.status === 'active') {
          if (entry.nextTickAt <= currentTime) {
            entry.nextTickAt = currentTime;
          }
          armInterval(entry);
        }
      }
    },

    revoke() {
      if (revoked) {
        return Promise.resolve();
      }
      revoked = true;
      disarmAll();
      const persistPromises = [];
      for (const entry of entries.values()) {
        if (entry.status !== 'cancelled') {
          entry.status = 'cancelled';
          persistPromises.push(persist(entry));
        }
      }
      return Promise.all(persistPromises).then(
        () => undefined,
        error =>
          console.error(
            '[interval-scheduler] failed to persist revocation:',
            error,
          ),
      );
    },

    async listAll() {
      return harden([...entries.values()].map(e => harden({ ...e })));
    },

    help: () =>
      [
        'IntervalControl — host-side management of an interval scheduler.',
        '',
        '  setMaxActive(n)     — set maximum active intervals (1-100)',
        `  setMinPeriodMs(ms)  — set minimum period floor (${ABSOLUTE_MIN_PERIOD_MS}-${MAX_PERIOD_MS}ms)`,
        '  pause()             — pause all intervals (disarm timers)',
        '  resume()            — resume all intervals (re-arm timers)',
        '  revoke()            — permanently revoke the scheduler',
        '  listAll()           — list all intervals including cancelled',
      ].join('\n'),
  });

  await recover();

  return harden({ scheduler, schedulerControl, disarmAll });
};
harden(makeIntervalScheduler);
