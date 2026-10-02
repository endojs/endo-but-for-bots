// @ts-check

import { Fail } from '@endo/errors';
import { mustMatch } from '@endo/patterns';

import { InferLimitsShape, InferResultShape } from './guards.js';

/** @import { InferLimits, InferResult, LimitEnforcer, LimitTimers } from './types.js' */

/**
 * Enforces one turn's `InferLimits` inside a provider plugin. The plugin
 * reports output bytes and model turns as it observes them; the enforcer
 * calls `terminate` exactly once, on the first limit reached, on
 * cancellation, or on an `abort` the plugin requests (for example a
 * classified response that ends the turn early). The first cause wins and is
 * reported by `outcome()`.
 *
 * The wall-clock timer starts at construction. The plugin calls `stop()` when
 * the turn ends by itself, after which nothing trips.
 *
 * @param {object} options
 * @param {InferLimits} options.limits
 * @param {LimitTimers} options.timers
 * @param {() => void} options.terminate  ends the provider process; it may
 *   run from a timer callback, where a throw is uncaught.
 * @param {PromiseLike<unknown>} [options.cancelled]  rejects to cancel the turn.
 * @returns {LimitEnforcer}
 */
export const makeLimitEnforcer = ({ limits, timers, terminate, cancelled }) => {
  mustMatch(harden(limits), InferLimitsShape, 'limits');
  const { maxWallClockMs, maxOutputBytes, maxTurns } = limits;

  /** @type {InferResult | undefined} */
  let outcome;
  let stopped = false;
  let outputBytes = 0;
  let turns = 0;

  const stop = () => {
    stopped = true;
    timers.clearTimeout(timer);
  };

  /** @param {InferResult} result */
  const abort = result => {
    if (stopped) return;
    mustMatch(result, InferResultShape, 'abort result');
    outcome = result;
    stop();
    terminate();
  };

  const timer = timers.setTimeout(
    () => abort(harden({ type: 'limit-exceeded', which: 'wall-clock' })),
    maxWallClockMs,
  );

  if (cancelled !== undefined) {
    cancelled.then(undefined, () => abort(harden({ type: 'cancelled' })));
  }

  /**
   * @param {number} byteCount
   * @returns {boolean} whether the turn may continue
   */
  const countOutputBytes = byteCount => {
    (Number.isSafeInteger(byteCount) && byteCount >= 0) ||
      Fail`byteCount must be a non-negative safe integer: ${byteCount}`;
    outputBytes += byteCount;
    if (outputBytes > maxOutputBytes) {
      abort(harden({ type: 'limit-exceeded', which: 'output-bytes' }));
    }
    return outcome === undefined;
  };

  /** @returns {boolean} whether the turn may continue */
  const countTurn = () => {
    turns += 1;
    if (turns > maxTurns) {
      abort(harden({ type: 'limit-exceeded', which: 'max-turns' }));
    }
    return outcome === undefined;
  };

  return harden({
    countOutputBytes,
    countTurn,
    abort,
    outcome: () => outcome,
    stop,
  });
};
harden(makeLimitEnforcer);

/**
 * Makes the `terminate` a process-spawning plugin hands the limit enforcer:
 * it signals the whole process group of a child spawned with
 * `detached: true`, so helpers the child started die with it. A group that
 * is already gone is not an error.
 *
 * @param {object} powers
 * @param {(pid: number, signal: string) => unknown} powers.kill  such as
 *   `process.kill`.
 * @param {string} [powers.signal]
 * @returns {(pid: number | undefined) => boolean} whether a signal was sent
 */
export const makeProcessGroupKiller = ({ kill, signal = 'SIGKILL' }) => {
  /** @param {number | undefined} pid */
  const killProcessGroup = pid => {
    if (pid === undefined) return false;
    try {
      kill(-pid, signal);
      return true;
    } catch (error) {
      if (/** @type {{ code?: unknown }} */ (error)?.code === 'ESRCH') {
        return false;
      }
      throw error;
    }
  };
  return harden(killProcessGroup);
};
harden(makeProcessGroupKiller);
