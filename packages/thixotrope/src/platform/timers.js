// @ts-check
import harden from '@endo/harden';

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
