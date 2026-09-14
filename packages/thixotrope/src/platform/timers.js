// @ts-check
import harden from '@endo/harden';

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
