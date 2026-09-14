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
 * So an alarm is a promise resource whose settlement is a pure function of its
 * description plus a deadline this module keeps. Nothing calls into the guest.
 * Resolving the promise settles the listener, and that delivery is what wakes
 * the vat — which is why there is no control facet, no publication, no
 * transient client, and no reconciliation scan here.
 *
 * @param {{ timers: TimerPowers }} powers
 * @param {object} options
 * @param {SyncStringAtom} options.storage
 * @param {() => bigint} [options.now] milliseconds since the epoch
 */
export const makeDurableAlarms = ({ timers }, { storage, now }) => {
  const readNow = now ?? (() => BigInt(timers.now()));

  /** @type {Map<string, {workerId: string, alarmId: string, deadline: bigint}>} */
  const armed = new Map();
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
    (state && state.version === 1 && Array.isArray(state.alarms)) ||
      Fail`Invalid durable alarm metadata`;
    for (const entry of state.alarms) {
      const { workerId, alarmId, deadline } = entry;
      (typeof workerId === 'string' &&
        typeof alarmId === 'string' &&
        typeof deadline === 'string') ||
        Fail`Invalid durable alarm entry`;
      armed.set(keyFor(workerId, alarmId), {
        workerId,
        alarmId,
        deadline: BigInt(deadline),
      });
    }
  };

  const save = () => {
    storage.write(
      JSON.stringify({
        version: 1,
        alarms: [...armed.values()].map(({ workerId, alarmId, deadline }) =>
          harden({ workerId, alarmId, deadline: `${deadline}` }),
        ),
      }),
    );
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
    }
    return kit.promise;
  };

  /** @param {string} key */
  const settle = key => {
    const entry = armed.get(key);
    if (entry === undefined) return;
    armed.delete(key);
    save();
    // Re-seat the promise if this process has not yet materialised it: the
    // guest's listener re-attaches to whatever the factory returns, so the
    // settled kit must be the one the export resolves to.
    provideAlarm(alarmDescription(entry.workerId, entry.alarmId));
    kits.get(key)?.resolve(readNow());
  };

  const rearm = () => {
    if (timer !== undefined) {
      timers.clearTimer(timer);
      timer = undefined;
    }
    if (stopped || armed.size === 0) return;
    const current = readNow();
    /** @type {bigint | undefined} */
    let earliest;
    for (const entry of armed.values()) {
      if (earliest === undefined || entry.deadline < earliest)
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
      for (const [key, entry] of [...armed]) {
        if (entry.deadline <= at) settle(key);
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
     * The facet a guest is granted. `workerId` binds it to one vat, so an
     * alarm armed for one guest cannot be listened to as another's.
     *
     * @param {string} workerId
     * @param {(name: string, description: unknown) => unknown} makeResource
     */
    facet: (workerId, makeResource) =>
      Far('DurableAlarms', {
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
          const existing = armed.get(key);
          if (existing !== undefined) {
            existing.deadline === deadline || Fail`Alarm deadline mismatch`;
          } else {
            armed.size < MAX_ALARMS || Fail`Too many pending alarms`;
            armed.set(key, { workerId, alarmId, deadline });
            save();
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
          if (!armed.has(key)) return false;
          armed.delete(key);
          save();
          kits.get(key)?.reject(Error('Alarm cancelled'));
          kits.delete(key);
          rearm();
          return true;
        },
        now: () => readNow(),
      }),

    /** Re-arm the host timer from durable state. Call after sessions restore. */
    start: () => {
      !stopped || Fail`Durable alarms are shut down`;
      rearm();
    },

    status: () =>
      harden({
        armed: BigInt(armed.size),
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
