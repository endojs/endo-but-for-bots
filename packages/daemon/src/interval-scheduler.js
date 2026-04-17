// @ts-check
/* global setTimeout, clearTimeout */

import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { q, Fail } from '@endo/errors';

import {
  IntervalSchedulerInterface,
  IntervalInterface,
  IntervalControlInterface,
  TickResponseInterface,
} from './interfaces.js';

/**
 * @typedef {object} IntervalEntry
 * @property {string} id
 * @property {string} label
 * @property {number} periodMs
 * @property {number} firstDelayMs
 * @property {number} tickTimeoutMs
 * @property {number} nextTickAt
 * @property {number} createdAt
 * @property {number} tickCount
 * @property {'active' | 'paused' | 'cancelled'} status
 */

let nextId = 0;
const generateId = () => {
  nextId += 1;
  return `interval-${nextId}`;
};

/**
 * Create an IntervalScheduler / IntervalControl facet pair.
 *
 * @param {object} options
 * @param {number} [options.maxActive] - Max concurrent active intervals.
 * @param {number} [options.minPeriodMs] - Minimum allowed period.
 * @param {(entry: IntervalEntry, tickNumber: number, tickResponse: object) => void} [options.onTick] - Callback when a tick fires. tickResponse is a one-shot exo with resolve() and reschedule().
 * @param {(entry: IntervalEntry) => void} [options.onEntryChange] - Called when an entry is created, updated, or cancelled. For persistence.
 * @param {(entryId: string) => void} [options.onEntryRemove] - Called when an entry is removed. For persistence.
 * @returns {{ scheduler: object, control: object, loadEntry: (entry: IntervalEntry) => void }}
 */
export const makeIntervalSchedulerKit = (options = {}) => {
  const {
    maxActive = 5,
    minPeriodMs = 30_000,
    onTick = undefined,
    onEntryChange = undefined,
    onEntryRemove = undefined,
  } = options;

  let currentMaxActive = maxActive;
  let currentMinPeriodMs = minPeriodMs;
  let paused = false;
  let revoked = false;

  /** @type {Map<string, IntervalEntry>} */
  const entries = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const activeTimeouts = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const tickDeadlines = new Map();

  const assertNotRevoked = () => {
    if (revoked) {
      throw Fail`Interval scheduler has been revoked`;
    }
  };

  /**
   * @param {string} entryId
   */
  const disarmInterval = entryId => {
    const handle = activeTimeouts.get(entryId);
    if (handle !== undefined) {
      clearTimeout(handle);
      activeTimeouts.delete(entryId);
    }
    const deadlineHandle = tickDeadlines.get(entryId);
    if (deadlineHandle !== undefined) {
      clearTimeout(deadlineHandle);
      tickDeadlines.delete(deadlineHandle);
    }
  };

  /**
   * @param {IntervalEntry} entry
   */
  const armInterval = entry => {
    if (paused || entry.status !== 'active') return;
    const now = Date.now();
    const delay = Math.max(0, entry.nextTickAt - now);
    const handle = setTimeout(() => onIntervalTick(entry.id), delay);
    handle.unref();
    activeTimeouts.set(entry.id, handle);
  };

  /**
   * @param {string} entryId
   */
  const onIntervalTick = entryId => {
    const entry = entries.get(entryId);
    if (!entry || entry.status !== 'active') return;

    activeTimeouts.delete(entryId);
    entry.tickCount += 1;
    let rescheduleCount = 0;
    let responded = false;

    if (onEntryChange) {
      onEntryChange(entry);
    }

    // Create a one-shot TickResponse exo for this tick.
    const tickResponse = makeExo(
      `TickResponse ${entry.label}#${entry.tickCount}`,
      TickResponseInterface,
      {
        resolve: () => {
          if (responded) return;
          responded = true;
          // Clear the deadline timeout.
          const dh = tickDeadlines.get(entryId);
          if (dh !== undefined) {
            clearTimeout(dh);
            tickDeadlines.delete(entryId);
          }
          advanceToNextPeriod(entry);
        },
        reschedule: () => {
          if (responded) return;
          rescheduleCount += 1;
          // Clear the deadline timeout.
          const dh = tickDeadlines.get(entryId);
          if (dh !== undefined) {
            clearTimeout(dh);
            tickDeadlines.delete(entryId);
          }
          // Exponential backoff, capped at tickTimeoutMs.
          const baseBackoff = Math.min(1000, entry.periodMs / 10);
          const backoffDelay = Math.min(
            baseBackoff * 2 ** (rescheduleCount - 1),
            entry.tickTimeoutMs,
          );
          const retryAt = Date.now() + backoffDelay;
          const deadline = entry.nextTickAt + entry.tickTimeoutMs;
          if (retryAt >= deadline) {
            // Backoff would exceed deadline — auto-resolve instead.
            responded = true;
            advanceToNextPeriod(entry);
            return;
          }
          const handle = setTimeout(
            () => onIntervalTick(entry.id),
            backoffDelay,
          );
          handle.unref();
          activeTimeouts.set(entry.id, handle);
        },
      },
    );

    if (onTick) {
      onTick(entry, entry.tickCount, tickResponse);
    }

    // Arm tick timeout — auto-resolve if agent doesn't respond.
    const deadlineHandle = setTimeout(() => {
      if (!responded) {
        responded = true;
        tickDeadlines.delete(entryId);
        console.log(
          `Interval "${entry.label}" tick #${entry.tickCount} timed out ` +
            `after ${entry.tickTimeoutMs}ms`,
        );
        advanceToNextPeriod(entry);
      }
    }, entry.tickTimeoutMs);
    deadlineHandle.unref();
    tickDeadlines.set(entryId, deadlineHandle);
  };

  /**
   * @param {IntervalEntry} entry
   */
  const advanceToNextPeriod = entry => {
    entry.nextTickAt += entry.periodMs;
    // If we've fallen behind, advance to the next future period.
    const now = Date.now();
    while (entry.nextTickAt <= now) {
      entry.nextTickAt += entry.periodMs;
    }
    if (onEntryChange) {
      onEntryChange(entry);
    }
    armInterval(entry);
  };

  /**
   * @param {IntervalEntry} entry
   */
  const makeIntervalExo = entry =>
    makeExo(`Interval ${entry.label}`, IntervalInterface, {
      label: () => entry.label,
      period: () => entry.periodMs,
      setPeriod: async newPeriodMs => {
        assertNotRevoked();
        newPeriodMs >= currentMinPeriodMs ||
          Fail`Period ${q(newPeriodMs)}ms is below minimum ${q(currentMinPeriodMs)}ms`;
        entry.periodMs = newPeriodMs;
      },
      cancel: async () => {
        disarmInterval(entry.id);
        entry.status = 'cancelled';
        if (onEntryChange) {
          onEntryChange(entry);
        }
      },
      info: () => harden({ ...entry }),
      help: () =>
        `Interval "${entry.label}" (${entry.periodMs}ms). ` +
        `Methods: label(), period(), setPeriod(ms), cancel(), info(), help()`,
    });

  const scheduler = makeExo(
    'IntervalScheduler',
    IntervalSchedulerInterface,
    {
      makeInterval: async (label, periodMs, opts = undefined) => {
        assertNotRevoked();
        const { firstDelayMs = 0, tickTimeoutMs = periodMs / 2 } = opts || {};

        periodMs >= currentMinPeriodMs ||
          Fail`Period ${q(periodMs)}ms is below minimum ${q(currentMinPeriodMs)}ms`;

        const activeCount = [...entries.values()].filter(
          e => e.status === 'active',
        ).length;
        activeCount < currentMaxActive ||
          Fail`Maximum active intervals (${q(currentMaxActive)}) reached`;

        const now = Date.now();
        /** @type {IntervalEntry} */
        const entry = {
          id: generateId(),
          label,
          periodMs,
          firstDelayMs,
          tickTimeoutMs,
          nextTickAt: now + firstDelayMs,
          createdAt: now,
          tickCount: 0,
          status: 'active',
        };
        entries.set(entry.id, entry);
        if (onEntryChange) {
          onEntryChange(entry);
        }
        armInterval(entry);
        return makeIntervalExo(entry);
      },
      list: async () =>
        harden(
          [...entries.values()]
            .filter(e => e.status === 'active')
            .map(e => harden({ ...e })),
        ),
      help: () =>
        `IntervalScheduler creates timed intervals for agent heartbeats. ` +
        `Methods: makeInterval(label, periodMs, opts?), list(), help(). ` +
        `Limits: maxActive=${currentMaxActive}, minPeriodMs=${currentMinPeriodMs}`,
    },
  );

  const control = makeExo(
    'IntervalControl',
    IntervalControlInterface,
    {
      setMaxActive: n => {
        n >= 1 || Fail`maxActive must be >= 1`;
        currentMaxActive = n;
      },
      setMinPeriodMs: ms => {
        ms >= 1000 || Fail`minPeriodMs must be >= 1000`;
        currentMinPeriodMs = ms;
      },
      pause: () => {
        paused = true;
        for (const [id] of activeTimeouts) {
          disarmInterval(id);
        }
      },
      resume: () => {
        paused = false;
        for (const entry of entries.values()) {
          if (entry.status === 'active') {
            // Recompute next tick relative to now
            const now = Date.now();
            if (entry.nextTickAt <= now) {
              entry.nextTickAt = now;
            }
            armInterval(entry);
          }
        }
      },
      revoke: () => {
        revoked = true;
        for (const entry of entries.values()) {
          disarmInterval(entry.id);
          entry.status = 'cancelled';
        }
      },
      listAll: async () =>
        harden([...entries.values()].map(e => harden({ ...e }))),
      help: () =>
        `IntervalControl manages the interval scheduler. ` +
        `Methods: setMaxActive(n), setMinPeriodMs(ms), pause(), resume(), revoke(), listAll(), help()`,
    },
  );

  /**
   * Load a previously persisted interval entry.
   * Used during startup recovery to restore intervals from disk.
   *
   * @param {IntervalEntry} entry
   */
  const loadEntry = entry => {
    entries.set(entry.id, entry);
    if (entry.status === 'active' && !paused) {
      armInterval(entry);
    }
  };

  return harden({ scheduler, control, loadEntry });
};
harden(makeIntervalSchedulerKit);
