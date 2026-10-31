// @ts-check

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/** @import { Timer } from './types.js' */

export const MAX_TIMER_DELAY_MILLISECONDS = 2 ** 31 - 1;
harden(MAX_TIMER_DELAY_MILLISECONDS);

export const TimerInterface = M.interface('Timer', {
  delay: M.callWhen(M.number()).optional(M.promise()).returns(M.undefined()),
  now: M.callWhen().returns(M.number()),
  help: M.call().returns(M.string()),
});

const timerHelp = `\
Timer - an unconfined source of delays and wall-clock time.

  delay(milliseconds, cancelled?) -> undefined
  now() -> wall-clock milliseconds since the epoch

Endow this to confined plugins that need time; do not grant it to guests.`;

/**
 * @param {number} milliseconds
 */
const validateDelay = milliseconds => {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_TIMER_DELAY_MILLISECONDS
  ) {
    throw makeError(
      X`Timer delay ${q(milliseconds)} must be an integer between 0 and ${q(
        MAX_TIMER_DELAY_MILLISECONDS,
      )} milliseconds`,
    );
  }
};

/**
 * @param {object} [powers]
 * @param {(callback: () => void, milliseconds: number) => unknown} [powers.setTimeout]
 * @param {(handle: unknown) => void} [powers.clearTimeout]
 * @param {() => number} [powers.now]
 * @returns {Timer}
 */
export const makeTimer = ({
  setTimeout = globalThis.setTimeout,
  clearTimeout = handle =>
    globalThis.clearTimeout(
      /** @type {ReturnType<typeof globalThis.setTimeout>} */ (handle),
    ),
  now = Date.now,
} = {}) =>
  makeExo('Timer', TimerInterface, {
    /**
     * @param {number} milliseconds
     * @param {PromiseLike<unknown>} [cancelled]
     */
    delay: (milliseconds, cancelled) => {
      validateDelay(milliseconds);
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(undefined);
        }, milliseconds);
        if (cancelled !== undefined) {
          void cancelled.then(
            () => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(makeError(X`Cancellation token must not fulfill`));
              }
            },
            reason => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(reason);
              }
            },
          );
        }
      });
    },
    now: async () => now(),
    help: () => timerHelp,
  });
harden(makeTimer);

/**
 * Unconfined-caplet entry point. The capability closes over the worker's
 * ambient timer and clock powers.
 */
export const make = () => makeTimer();
harden(make);
