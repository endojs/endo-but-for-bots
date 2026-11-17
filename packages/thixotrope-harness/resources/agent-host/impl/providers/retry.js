// @ts-check
/**
 * Provider retries (M2 W2.1b; R4-74, R4-77, R4-78, R4-105; open decision
 * 12; designs/m2-interfaces.md 8.2).
 *
 * `withRetries({ attempt, maxAttempts, delayMs, sleep, signal })` runs
 * `attempt(signal)` (an async iterable of round events, `round.js`) and
 * passes its events on. An attempt that fails with a retryable
 * `ProviderFailure` is run again, at most `maxAttempts` times in all, after
 * `delayMs(n, retryAfterMs)`, but only while it delivered nothing (R4-74,
 * lal `providers/openrouter.js` 9-20: "never once a message was delivered
 * or positive token usage was reported"):
 *
 * - a `{ delta }` is a delivery: it is passed on at once (the round
 *   publishes it to the session's channel) and the round is never retried
 *   after it (R4-78: a partial answer is never replayed);
 * - a `{ usage }` that reports tokens is a delivery (tokens were consumed);
 *   one that reports none is not;
 * - every other event (`toolCall`, `servedBy`, `nativeContext`, `stop`, a
 *   zero `usage`) is held until the first delivery or the attempt's end,
 *   and dropped when the attempt is retried, so a retried attempt leaves
 *   nothing behind in the round.
 *
 * A timed-out attempt is retried at most `maxTimeoutRetries` times (lal:
 * once). The last failure is reported as
 * `textOf.afterAttempts(reason, attempts)` with the failure's other fields
 * kept. The caller's cancel (`signal`) ends the wait and the attempt at
 * once; the abort is passed on as it came, never retried or reworded.
 * Anything an attempt throws that is not a `ProviderFailure` is not
 * retried (the round reports it with the provider's fixed text, R4-79).
 *
 * Schedules (m2-interfaces.md 8.2): OpenRouter `min(30 s, max(Retry-After,
 * 1,000 ms x 3^(n-1)))`, 3 attempts (R4-74, R4-105); Anthropic API
 * `min(8 s, max(Retry-After, 500 ms x 2^(n-1)))`, 3 attempts (R4-77's "SDK
 * default retries" [inferred], a harness choice: the SDK's initial 0.5 s,
 * doubling, at most 8 s; the SDK honours a Retry-After of up to 60 s, the
 * contract caps it at 8 s).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { textOf } from '../../../../guest/lib/interfaces.js';
import { tokenCount } from '../../../../guest/lib/token-usage.js';
/* eslint-enable import/no-relative-packages */
import { ProviderFailure } from './round.js';

/** Attempts per round (R4-105). */
export const MAX_ATTEMPTS = 3;
/** Timed-out attempts retried per round (lal: at most one). */
export const MAX_TIMEOUT_RETRIES = 1;

/**
 * OpenRouter's wait before attempt `n + 1` (R4-74).
 * @param {number} n the attempt that failed (1-based)
 * @param {number} [retryAfterMs]
 */
export const openRouterDelay = (n, retryAfterMs) =>
  Math.min(30_000, Math.max(retryAfterMs ?? 0, 1000 * 3 ** (n - 1)));
harden(openRouterDelay);

/**
 * The Anthropic API's wait before attempt `n + 1` (m2-interfaces.md 8.2).
 * @param {number} n the attempt that failed (1-based)
 * @param {number} [retryAfterMs]
 */
export const anthropicDelay = (n, retryAfterMs) =>
  Math.min(8000, Math.max(retryAfterMs ?? 0, 500 * 2 ** (n - 1)));
harden(anthropicDelay);

/**
 * Whether a round event is a delivery (R4-74).
 * @param {import('./round.js').RoundEvent} event
 */
export const isDelivery = event => {
  if ('delta' in event)
    return typeof event.delta === 'string' && event.delta !== '';
  if ('usage' in event) {
    const usage = event.usage ?? {};
    return (
      tokenCount(usage.inputTokens) +
        tokenCount(usage.outputTokens) +
        tokenCount(usage.cachedInputTokens) +
        tokenCount(usage.cacheWriteInputTokens) +
        tokenCount(usage.reasoningOutputTokens) >
      0
    );
  }
  return false;
};
harden(isDelivery);

/**
 * @typedef {object} RetryNotice
 * @property {number} attempt the attempt that failed (1-based)
 * @property {ProviderFailure} failure
 * @property {number} waitMs
 */

/**
 * @param {object} options
 * @param {(signal: AbortSignal) => AsyncIterable<import('./round.js').RoundEvent>} options.attempt
 * @param {number} [options.maxAttempts]
 * @param {(n: number, retryAfterMs?: number) => number} options.delayMs
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} options.sleep
 *   resolves after `ms`, or early when `signal` aborts
 * @param {AbortSignal} options.signal the round's cancel
 * @param {number} [options.maxTimeoutRetries]
 * @param {(notice: RetryNotice) => void} [options.onRetry]
 * @returns {AsyncGenerator<import('./round.js').RoundEvent, void, undefined>}
 */
export async function* withRetries({
  attempt,
  maxAttempts = MAX_ATTEMPTS,
  delayMs,
  sleep,
  signal,
  maxTimeoutRetries = MAX_TIMEOUT_RETRIES,
  onRetry,
}) {
  let timeouts = 0;
  for (let n = 1; ; n += 1) {
    let delivered = false;
    /** @type {import('./round.js').RoundEvent[]} */
    let held = [];
    /** @type {unknown} */
    let failure;
    let failed = false;
    try {
      // eslint-disable-next-line no-await-in-loop -- one attempt at a time
      for await (const event of attempt(signal)) {
        if (delivered) {
          yield event;
        } else if (isDelivery(event)) {
          delivered = true;
          const before = held;
          held = [];
          yield* before;
          yield event;
        } else {
          held.push(event);
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (!failed) {
      yield* held;
      return;
    }
    if (signal.aborted || !(failure instanceof ProviderFailure)) {
      yield* held;
      throw failure;
    }
    const timedOut = failure.timedOut === true;
    if (timedOut) timeouts += 1;
    const again =
      failure.retryable === true &&
      !delivered &&
      failure.delivered !== true &&
      n < maxAttempts &&
      (!timedOut || timeouts <= maxTimeoutRetries);
    if (!again) {
      yield* held;
      if (n === 1) throw failure;
      throw new ProviderFailure(textOf.afterAttempts(failure.reason, n), {
        retryable: false,
        timedOut: failure.timedOut,
        delivered: delivered || failure.delivered,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
      });
    }
    const waitMs = Math.max(0, delayMs(n, failure.retryAfterMs));
    onRetry?.(harden({ attempt: n, failure, waitMs }));
    // eslint-disable-next-line no-await-in-loop
    await sleep(waitMs, signal);
    if (signal.aborted) {
      // The caller's cancel during the wait: as an abort mid-attempt.
      throw failure;
    }
  }
}
harden(withRetries);

/**
 * A wait that ends early when `signal` aborts.
 * @param {import('../timers.js').Timers} timers
 * @returns {(ms: number, signal: AbortSignal) => Promise<void>}
 */
export const sleeperOf = timers => (ms, signal) =>
  new Promise(resolve => {
    if (signal.aborted || ms <= 0) {
      resolve(undefined);
      return;
    }
    /** @type {() => void} */
    let cancel = () => {};
    const done = () => {
      cancel();
      signal.removeEventListener('abort', done);
      resolve(undefined);
    };
    cancel = timers.after(ms, done);
    signal.addEventListener('abort', done, { once: true });
  });
harden(sleeperOf);

/**
 * The providers' `retry` option (`makeOpenRouterProvider`,
 * `makeAnthropicProvider`): `({ attempt, signal }) => AsyncIterable`.
 * @param {object} options
 * @param {import('../timers.js').Timers} options.timers
 * @param {(n: number, retryAfterMs?: number) => number} options.delayMs
 * @param {number} [options.maxAttempts]
 * @param {number} [options.maxTimeoutRetries]
 * @param {(notice: RetryNotice) => void} [options.onRetry]
 */
export const makeRetry = ({
  timers,
  delayMs,
  maxAttempts = MAX_ATTEMPTS,
  maxTimeoutRetries = MAX_TIMEOUT_RETRIES,
  onRetry,
}) => {
  const sleep = sleeperOf(timers);
  /**
   * @param {{ attempt: (signal: AbortSignal) => AsyncIterable<import('./round.js').RoundEvent>, signal: AbortSignal }} args
   */
  return ({ attempt, signal }) =>
    withRetries({
      attempt,
      signal,
      delayMs,
      sleep,
      maxAttempts,
      maxTimeoutRetries,
      ...(onRetry === undefined ? {} : { onRetry }),
    });
};
harden(makeRetry);
