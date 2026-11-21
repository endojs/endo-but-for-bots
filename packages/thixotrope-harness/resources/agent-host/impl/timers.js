// @ts-check
/**
 * Adapter timers (M1a W1a.2; architecture section 8: interactive timers are
 * adapter timers, not the clock resource). They die with the adapter
 * process, which is correct: the turn they belong to dies with it too.
 *
 * Node only. Tests pass a fake with the same two methods.
 */
import { clearTimeout, setTimeout } from 'node:timers';
import { Far } from '@endo/far';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { interfaces } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

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

/**
 * The `Timer` exo of `TurnPorts.timer` (M1b W1b.1; m1b-interfaces.md 3.1):
 * the exec vat's `sleep(ms)`. It dies with this incarnation (a sleep in
 * flight at a restart rejects with the retired text in the exec vat).
 * @param {Timers} timers
 */
export const makeTimerFacet = timers =>
  /** @type {any} */ (globalThis).makeExo('Timer', interfaces.Timer, {
    /** @param {number} ms */
    sleep: async ms => {
      await timers.delay(ms);
    },
    /** @param {number} ms */
    alarm: ms => {
      const { promise, resolve } = Promise.withResolvers();
      const cancel = timers.after(ms, () => resolve(true));
      return Far('Alarm', {
        whenExpired: () => promise,
        cancel: () => {
          cancel();
          resolve(false);
        },
      });
    },
  });
harden(makeTimerFacet);
