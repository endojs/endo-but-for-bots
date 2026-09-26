// @ts-check
/** @import { TimerPowers } from '../platform/timers.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { SyncStringAtom } from '../store/sync-string-atom.js' */
import { Fail, q } from '@endo/errors';
import { Far } from '@endo/far';
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';

import { MAX_TIMER_DELAY_MS } from '../platform/timers.js';

const MAX_TIME = 2n ** 63n - 1n;
const MAX_ALARMS = 1024;

/** @param {unknown} value @returns {asserts value is bigint} */
const assertTime = value => {
  (typeof value === 'bigint' && value >= 0n && value <= MAX_TIME) ||
    Fail`Expected nonnegative signed 64-bit milliseconds, got ${q(value)}`;
};

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
const assertAlarmId = value => {
  (typeof value === 'string' && value.length > 0 && value.length <= 128) ||
    Fail`Alarm id must be 1 to 128 characters, got ${q(value)}`;
};

/**
 * @param {unknown} value
 * @returns {asserts value is { workerId: string }}
 */
const assertClockDescription = value => {
  (typeof value === 'object' &&
    value !== null &&
    'workerId' in value &&
    typeof (/** @type {any} */ (value).workerId) === 'string') ||
    Fail`Invalid clock description ${q(value)}`;
};

/**
 * @param {unknown} value
 * @returns {asserts value is { workerId: string, alarmId: string }}
 */
const assertAlarmDescription = value => {
  (typeof value === 'object' &&
    value !== null &&
    'workerId' in value &&
    'alarmId' in value &&
    typeof (/** @type {any} */ (value).workerId) === 'string' &&
    typeof (/** @type {any} */ (value).alarmId) === 'string') ||
    Fail`Invalid alarm description ${q(value)}`;
};

/**
 * The description under which an alarm's promise is exported, and therefore
 * the key `provideResource` memoises it by and the key the endpoint records in
 * the worker's table of exports. Built in one place so that the description
 * reconstructed at restore is byte-identical to the one issued at arming —
 * `provideResource` keys on `JSON.stringify`, so property order matters.
 *
 * @param {string} workerId
 * @param {string} alarmId
 */
const alarmDescription = (workerId, alarmId) => harden({ workerId, alarmId });

/**
 * Durable alarms: the host half of a guest that waits.
 *
 * A guest awaiting a host *answer* loses it when the host restarts — the
 * computation that owed it died. A guest listening on a host *promise* does
 * not, provided the host can re-create that promise from a durable
 * description: the endpoint re-seats the export through the registered
 * resource factory and OCapN re-attaches the listener.
 *
 * An alarm is a promise resource whose deadline and eventual outcome this
 * module records before delivery. The guest acknowledges after recording its
 * own settlement, allowing the host to delete the outcome. Nothing calls into the guest.
 * Resolving the promise settles the listener, and that delivery is what wakes
 * the vat — which is why there is no control facet, no publication, no
 * transient client, and no reconciliation scan here.
 *
 * @param {{ timers: TimerPowers }} powers
 * @param {object} options
 * @param {SyncStringAtom} options.storage
 * @param {(name: string, description?: unknown) => any} options.makeResource
 *   the daemon's, late-bound because the daemon does not exist yet when this
 *   is constructed
 * @param {() => bigint} [options.now] milliseconds since the epoch
 */
export const makeDurableAlarms = (
  { timers },
  { storage, makeResource, now },
) => {
  const readNow = now ?? (() => BigInt(timers.now()));

  /** @typedef {{workerId: string, alarmId: string, deadline: bigint, outcome?: bigint | 'cancelled'}} AlarmRow */
  /** @type {Map<string, AlarmRow>} */
  let rows = new Map();
  /** @type {Map<string, PromiseKit<bigint>>} */
  const kits = new Map();
  let stopped = false;
  /** @type {unknown} */
  let timer;

  /**
   * @param {string} workerId @param {string} alarmId
   * @param alarmId
   */
  const keyFor = (workerId, alarmId) => `${workerId}:${alarmId}`;

  const load = () => {
    const saved = storage.read();
    if (saved === undefined) return;
    const state = JSON.parse(saved);
    (state &&
      (state.version === 1 || state.version === 2) &&
      Array.isArray(state.alarms)) ||
      Fail`Invalid durable alarm metadata`;
    for (const entry of state.alarms) {
      const { workerId, alarmId, deadline, outcome } = entry;
      (typeof workerId === 'string' &&
        typeof alarmId === 'string' &&
        typeof deadline === 'string') ||
        Fail`Invalid durable alarm entry`;
      outcome === undefined ||
        outcome === 'cancelled' ||
        (typeof outcome === 'string' && /^[0-9]+$/.test(outcome)) ||
        Fail`Invalid durable alarm outcome`;
      rows.set(keyFor(workerId, alarmId), {
        workerId,
        alarmId,
        deadline: BigInt(deadline),
        outcome:
          outcome === undefined || outcome === 'cancelled'
            ? outcome
            : BigInt(outcome),
      });
    }
  };

  /** @param {Map<string, AlarmRow>} next */
  const commit = next => {
    storage.write(
      JSON.stringify({
        version: 2,
        alarms: [...next.values()].map(
          ({ workerId, alarmId, deadline, outcome }) => ({
            workerId,
            alarmId,
            deadline: `${deadline}`,
            ...(outcome === undefined ? {} : { outcome: `${outcome}` }),
          }),
        ),
      }),
    );
    rows = next;
  };

  /** @param {string} key @param {AlarmRow} row */
  const put = (key, row) => {
    const next = new Map(rows);
    next.set(key, row);
    commit(next);
  };

  load();

  /**
   * The resource factory. Called both when a guest arms an alarm and again,
   * for the same description, when a restart re-seats the guest's export — so
   * it must be idempotent per description and must not consult the deadline.
   *
   * @param {unknown} description
   */
  const provideAlarm = description => {
    assertAlarmDescription(description);
    const key = keyFor(description.workerId, description.alarmId);
    let kit = kits.get(key);
    if (kit === undefined) {
      kit = makePromiseKit();
      // A caller that never listens must not become an unhandled rejection.
      void kit.promise.catch(() => {});
      kits.set(key, kit);
      const row = rows.get(key);
      if (row === undefined) kit.reject(Error('Alarm released'));
      else if (row.outcome === 'cancelled')
        kit.reject(Error('Alarm cancelled'));
      else if (row.outcome !== undefined) kit.resolve(row.outcome);
    }
    return kit.promise;
  };

  /** @param {string} key */
  const settle = key => {
    const entry = rows.get(key);
    if (entry === undefined || entry.outcome !== undefined) return;
    const at = readNow();
    put(key, { ...entry, outcome: at });
    // Re-seat the promise if this process has not yet materialised it: the
    // guest's listener re-attaches to whatever the factory returns, so the
    // settled kit must be the one the export resolves to.
    provideAlarm(alarmDescription(entry.workerId, entry.alarmId));
    kits.get(key)?.resolve(at);
  };

  const rearm = () => {
    if (timer !== undefined) {
      timers.clearTimer(timer);
      timer = undefined;
    }
    if (stopped || rows.size === 0) return;
    const current = readNow();
    /** @type {bigint | undefined} */
    let earliest;
    for (const entry of rows.values()) {
      if (
        entry.outcome === undefined &&
        (earliest === undefined || entry.deadline < earliest)
      )
        earliest = entry.deadline;
    }
    if (earliest === undefined) return;
    const delay = earliest <= current ? 0n : earliest - current;
    // A deadline further out than the host timer can express is re-armed on
    // the next expiry rather than truncated to fire early.
    const delayMs =
      delay > BigInt(MAX_TIMER_DELAY_MS) ? MAX_TIMER_DELAY_MS : Number(delay);
    timer = timers.setTimer(() => {
      timer = undefined;
      const at = readNow();
      for (const [key, entry] of [...rows]) {
        if (entry.outcome === undefined && entry.deadline <= at) settle(key);
      }
      rearm();
    }, delayMs);
  };

  return harden({
    /**
     * Register as `resources: { alarm: alarms.resource }`. The guest never
     * names this directly; it receives the promise as a value.
     */
    resource: provideAlarm,

    /**
     * The facet a guest is granted, as a resource keyed by the vat it is for.
     *
     * A resource rather than a plain `Far`, because a guest holds this across
     * host restarts: an export the endpoint cannot describe comes back as a
     * tombstone, and a clock that could never arm another alarm after the first
     * restart would be worse than no clock at all.
     *
     * `workerId` binds it to one vat, so an alarm armed for one guest cannot be
     * listened to as another's.
     *
     * @param {unknown} description
     * @returns {object}
     */
    clockResource: description => {
      assertClockDescription(description);
      const { workerId } = description;
      return Far('DurableAlarms', {
        help: () =>
          'arm(alarmId, deadline) returns a promise that settles with the host time at or after the deadline, and survives host restart; cancel(alarmId) breaks it; now() reads host time.',
        /**
         * @param {string} alarmId caller-chosen, unique within this vat
         * @param {bigint} deadline milliseconds since the epoch
         */
        arm: (alarmId, deadline) => {
          !stopped || Fail`Durable alarms are shut down`;
          assertAlarmId(alarmId);
          assertTime(deadline);
          const key = keyFor(workerId, alarmId);
          const existing = rows.get(key);
          if (existing !== undefined) {
            existing.deadline === deadline || Fail`Alarm deadline mismatch`;
          } else {
            rows.size < MAX_ALARMS || Fail`Too many unacknowledged alarms`;
            put(key, { workerId, alarmId, deadline });
            rearm();
          }
          // Wrapped in a record, deliberately. A promise returned bare
          // becomes this call's answer — the answer would then wait for the
          // deadline and, being an answer, would abort on host restart, which
          // is the exact opposite of what an alarm needs. Inside a record it
          // travels as a promise reference the guest can listen on.
          return harden({
            settlement: makeResource(
              'alarm',
              alarmDescription(workerId, alarmId),
            ),
          });
        },
        /** @param {string} alarmId */
        cancel: alarmId => {
          const key = keyFor(workerId, alarmId);
          const row = rows.get(key);
          if (row === undefined || row.outcome !== undefined) return false;
          put(key, { ...row, outcome: 'cancelled' });
          provideAlarm(alarmDescription(workerId, alarmId));
          kits.get(key)?.reject(Error('Alarm cancelled'));
          rearm();
          return true;
        },
        // The guest releases only after recording its own settlement, or
        // abandoning an arm whose answer was interrupted. Repeated releases
        // are harmless, including after the release reply was lost.
        /** @param {string} alarmId */
        release: alarmId => {
          const key = keyFor(workerId, alarmId);
          // Even an absent row needs a write: an earlier arm may have
          // published its file and then failed to sync, leaving memory behind.
          const next = new Map(rows);
          next.delete(key);
          commit(next);
          kits.delete(key);
          rearm();
        },
        now: () => readNow(),
      });
    },

    /** Re-arm the host timer from durable state. Call after sessions restore. */
    start: () => {
      !stopped || Fail`Durable alarms are shut down`;
      rearm();
    },

    status: () =>
      harden({
        armed: BigInt(
          [...rows.values()].filter(row => row.outcome === undefined).length,
        ),
        retained: BigInt(rows.size),
        materialised: BigInt(kits.size),
        stopped,
      }),

    shutdown: () => {
      stopped = true;
      if (timer !== undefined) timers.clearTimer(timer);
      timer = undefined;
    },
  });
};
harden(makeDurableAlarms);
