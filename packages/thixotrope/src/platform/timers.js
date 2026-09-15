// @ts-check
/** @import { PromiseKit } from '@endo/promise-kit' */
import harden from '@endo/harden';
import { makePromiseKit, racePromises } from '@endo/promise-kit';

/**
 * The longest delay `setTimer` accepts. Node's `setTimeout` silently treats a
 * larger delay — and `NaN` — as about a millisecond, so a "24.9 day" timer
 * fires immediately instead of failing. Callers validate against this rather
 * than discover it at run time, and a port for another host must honour the
 * same bound.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
harden(MAX_TIMER_DELAY_MS);

/**
 * Timer handles are opaque host values. Core passes them back to
 * {@link TimerPowers.clearTimer} and never inspects them.
 *
 * @typedef {unknown} TimerHandle
 *
 * @typedef {object} TimerPowers
 * @property {() => number} now wall-clock milliseconds since the epoch
 * @property {() => number} monotonicNow milliseconds from an arbitrary
 *   origin, for measuring durations
 * @property {(callback: () => void, delayMs: number) => TimerHandle} setTimer
 * @property {(handle: TimerHandle) => void} clearTimer
 * @property {(handle: TimerHandle) => void} [unrefTimer] let the host
 *   process exit with this timer still pending; absent on hosts without
 *   that notion
 *
 * @param {object} host
 * @param {() => number} host.now
 * @param {() => number} host.monotonicNow
 * @param {(callback: () => void, delayMs: number) => TimerHandle} host.setTimer
 * @param {(handle: TimerHandle) => void} host.clearTimer
 * @param {(handle: TimerHandle) => void} [host.unrefTimer]
 * @returns {TimerPowers}
 */
/**
 * Arm `onExpire` for the duration of `operation`, and clear it however
 * `operation` ends.
 *
 * Every caller that bounds an await otherwise repeats the clear in a
 * `finally`, which is easy to write and easier to leave out — and a timer that
 * outlives the work it was bounding keeps the host's event loop alive and can
 * escalate against something that has already finished.
 *
 * @template T
 * @param {TimerPowers} timers
 * @param {number} delayMs
 * @param {() => void} onExpire
 * @param {() => T | Promise<T>} operation
 * @returns {Promise<Awaited<T>>}
 */
export const withExpiry = async (timers, delayMs, onExpire, operation) => {
  const timer = timers.setTimer(onExpire, delayMs);
  try {
    return await operation();
  } finally {
    timers.clearTimer(timer);
  }
};
harden(withExpiry);

/**
 * Wait for `promise`, but stop waiting after `delayMs` and carry on.
 *
 * The abandoned work is not cancelled — nothing here can cancel it — so this
 * is only right where continuing without it is safe and where whatever it
 * would have cleaned up is discarded by some later means. A guest that never
 * settles its cancellation must not be able to hold a host shutdown open; its
 * leftovers are dropped at the next start instead.
 *
 * @param {TimerPowers} timers
 * @param {number} delayMs
 * @param {Promise<unknown>} promise
 * @returns {Promise<void>} settles when `promise` does, or when the delay
 *   elapses; rejects only if `promise` rejects first
 */
export const settleWithin = async (timers, delayMs, promise) => {
  /** @type {PromiseKit<void>} */
  const elapsed = makePromiseKit();
  await withExpiry(
    timers,
    delayMs,
    () => elapsed.resolve(),
    () => racePromises([promise, elapsed.promise]),
  );
};
harden(settleWithin);

export const makeTimerPowers = ({
  now,
  monotonicNow,
  setTimer,
  clearTimer,
  unrefTimer,
}) => {
  const powers = harden({
    now,
    monotonicNow,
    setTimer,
    clearTimer,
  });
  if (unrefTimer === undefined) return powers;
  return harden({ ...powers, unrefTimer });
};
harden(makeTimerPowers);
