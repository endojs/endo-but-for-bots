// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { mustMatch } from '@endo/patterns';

import { ClassifiedResultShape, InferLimitsShape } from './guards.js';

/** @import { ClassifiedResult, InferLimits, LimitEnforcer, LimitTimers } from './types.js' */

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
 * @param {InferLimits} options.limits  `maxWallClockMs` is at most
 *   `MAX_TIMER_DELAY_MS`, and `maxOutputBytes` and `maxTurns` are positive
 *   safe integers.
 * @param {LimitTimers} options.timers
 * @param {() => void} options.terminate  ends the provider process; it may
 *   run from the wall-clock timer callback or from the `cancelled`
 *   rejection reaction, where a throw would be uncaught, so the enforcer
 *   catches a throw from it and hands it to `reportTerminateError`. The
 *   recorded outcome stands.
 * @param {(error: unknown) => void} [options.reportTerminateError]  learns
 *   that the provider process may still be running.
 * @param {PromiseLike<unknown>} [options.cancelled]  rejects to cancel the
 *   turn. `InferenceBackendInterface` admits only a genuine promise here;
 *   the enforcer still adopts it through `E.when`, so a direct caller's
 *   thenable whose `then` throws cancels the turn rather than failing
 *   construction.
 * @returns {LimitEnforcer}
 */
export const makeLimitEnforcer = ({
  limits,
  timers,
  terminate,
  reportTerminateError = () => {},
  cancelled,
}) => {
  mustMatch(harden(limits), InferLimitsShape, 'limits');
  const { maxWallClockMs, maxOutputBytes, maxTurns } = limits;
  Number.isSafeInteger(maxOutputBytes) ||
    Fail`maxOutputBytes must be a safe integer: ${maxOutputBytes}`;
  Number.isSafeInteger(maxTurns) ||
    Fail`maxTurns must be a safe integer: ${maxTurns}`;

  /** @type {ClassifiedResult | undefined} */
  let outcome;
  let stopped = false;
  let outputBytes = 0;
  let turns = 0;
  /** @type {unknown} */
  let timer;

  const stop = () => {
    stopped = true;
    timers.clearTimeout(timer);
  };

  /** @param {ClassifiedResult} result */
  const abort = result => {
    if (stopped) return;
    mustMatch(result, ClassifiedResultShape, 'abort result');
    outcome = result;
    stop();
    try {
      terminate();
    } catch (error) {
      // The outcome is already recorded; a failed signal must not escape
      // into a timer callback or rejection reaction and crash the host.
      reportTerminateError(error);
    }
  };

  // Subscribe before arming the timer, so nothing can throw once it is armed.
  if (cancelled !== undefined) {
    void E.when(cancelled, undefined, () =>
      abort(harden({ type: 'cancelled' })),
    );
  }

  try {
    timer = timers.setTimeout(
      () => abort(harden({ type: 'limit-exceeded', which: 'wall-clock' })),
      maxWallClockMs,
    );
  } catch (error) {
    // The caller never receives this enforcer, so the cancellation reaction
    // already subscribed above must not terminate anything.
    stopped = true;
    throw error;
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
 * it signals the whole process group of one child spawned with
 * `detached: true`, so helpers the child started die with it. The child's
 * pid is bound when the killer is made, so the killer signals only the group
 * that pid names. The operating system may reuse the pid once that group has
 * exited, so the plugin should stop using the killer once it has reaped the
 * child. A group that is already gone is not an error.
 * Windows has no POSIX process groups, so on `win32` the child itself is
 * signalled instead of its negated pid.
 *
 * @param {object} powers
 * @param {(pid: number, signal: string) => unknown} powers.kill  such as
 *   `process.kill`.
 * @param {number | undefined} powers.pid  the child's pid, such as
 *   `child.pid`; `undefined` (the spawn failed) makes a killer that signals
 *   nothing. Any other value must be an integer in `[2, 2 ** 31 - 1]`:
 *   negating `0` or `1` would name the caller's own group or every process.
 * @param {string} [powers.signal]
 * @param {string} powers.platform  such as `process.platform`. Required, so
 *   a forgotten power fails at construction instead of choosing the POSIX
 *   branch on Windows.
 * @returns {() => boolean} whether a signal was sent
 */
export const makeProcessGroupKiller = ({
  kill,
  pid,
  signal = 'SIGKILL',
  platform,
}) => {
  typeof platform === 'string' ||
    Fail`platform must be a string, such as process.platform: ${platform}`;
  if (pid !== undefined) {
    (Number.isInteger(pid) && pid > 1 && pid <= 2 ** 31 - 1) ||
      Fail`pid must be an integer from 2 to 2 ** 31 - 1: ${pid}`;
  }
  const groupKill = platform !== 'win32';
  const killProcessGroup = () => {
    if (pid === undefined) return false;
    try {
      kill(groupKill ? -pid : pid, signal);
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
