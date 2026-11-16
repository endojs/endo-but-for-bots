// @ts-check
/**
 * Adapter timers (M1a W1a.2; architecture section 8: interactive timers are
 * adapter timers, not the clock resource). They die with the adapter
 * process, which is correct: the turn they belong to dies with it too.
 *
 * Node only. Tests pass a fake with the same two methods.
 */
import { clearTimeout, setTimeout } from 'node:timers';

/**
 * @typedef {object} Timers
 * @property {(ms: number) => Promise<void>} delay resolves after `ms`
 * @property {(ms: number, fn: () => void) => () => void} after runs `fn`
 *   after `ms` unless the returned cancel was called first
 */

/** @returns {Timers} */
export const makeTimers = () => {
  /**
   * @param {number} ms
   * @param {() => void} fn
   */
  const after = (ms, fn) => {
    const handle = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(handle);
  };
  /** @param {number} ms */
  const delay = ms =>
    new Promise(resolve => {
      setTimeout(resolve, Math.max(0, ms));
    });
  return harden({ delay, after });
};
harden(makeTimers);
