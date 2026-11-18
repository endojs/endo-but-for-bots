// @ts-check
/**
 * What the two subscription wire clients share (M4 W4.3;
 * `designs/m4-interfaces.md` 5.2, 5.3; `subscriptions/types.js`
 * `WireAttempt`): the failure a member attempt throws, the fetch that hands
 * every answer's rate-limit headers to `onReading` before anything reads the
 * body, and the overload retry (R4-75, R4-105; D-M4-4) over M2's
 * `withRetries`.
 *
 * A wire failure is M2's `ProviderFailure` with the pool provider's facts on
 * it (`exhausted`, `rejected`, `overloaded`): the pool provider (W4.6) reads
 * them to choose between handing the request to the next member, renewing
 * the credential once, retrying on the overload schedule and failing the
 * round. `retryable` is set only for an overload before any delivery, so
 * `withRetries` retries nothing else.
 *
 * No header value, body or token is kept: `onReading` receives the parsed
 * reading of W4.2's `readingFromHeaders` (numbers, instants and closed
 * words), and `exhausted` carries a time only.
 *
 * Node only (adapter).
 */
import { ProviderFailure } from '../providers/round.js';
import { withRetries, sleeperOf } from '../providers/retry.js';
import { isExhausted, readingFromHeaders } from './rate-limit-headers.js';

/**
 * @typedef {object} WireFacts
 * @property {number} [status] the HTTP status of a refused answer
 * @property {{ untilMs: number | null }} [exhausted] a 429 whose headers say
 *   the subscription is used up (`isExhausted`); `untilMs` is the reset the
 *   reading named, else null
 * @property {true} [rejected] a 401: the credential was refused
 * @property {true} [overloaded] the provider said it is overloaded
 * @property {boolean} [delivered] text or tokens reached the round
 * @property {boolean} [retryable]
 * @property {boolean} [timedOut]
 * @property {number} [retryAfterMs]
 */

/**
 * A member attempt's failure: `ProviderFailure` plus the pool's facts.
 * @param {string} reason a fixed text (`m4Texts`, `m4TextOf`, M2 texts)
 * @param {WireFacts} [facts]
 * @returns {ProviderFailure & { exhausted?: { untilMs: number | null }, rejected?: true, overloaded?: true }}
 */
export const wireFailure = (reason, facts = {}) => {
  const failure = new ProviderFailure(reason, {
    retryable: facts.retryable ?? false,
    delivered: facts.delivered ?? false,
    ...(facts.status === undefined ? {} : { status: facts.status }),
    ...(facts.timedOut === undefined ? {} : { timedOut: facts.timedOut }),
    ...(facts.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: facts.retryAfterMs }),
  });
  return Object.assign(failure, {
    ...(facts.exhausted === undefined
      ? {}
      : { exhausted: harden({ ...facts.exhausted }) }),
    ...(facts.rejected ? { rejected: /** @type {const} */ (true) } : {}),
    ...(facts.overloaded ? { overloaded: /** @type {const} */ (true) } : {}),
  });
};
harden(wireFailure);

/** The pool facts a wire failure may carry (copied across a retry). */
const FACTS = harden(['exhausted', 'rejected', 'overloaded']);

/**
 * A `fetch` that hands each answer's rate-limit reading to `onReading` (2xx
 * or not, R4-84: readings come from every answer) and remembers the last
 * answer's status and header getter for the caller's failure mapping.
 * `onReading` throwing never changes how the request settles.
 * @param {object} options
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(reading: any) => void} [options.onReading]
 * @param {() => number} [options.now]
 */
export const observingFetch = ({
  fetch = globalThis.fetch,
  onReading,
  now = () => Date.now(),
}) => {
  /** @type {{ status: number, get: (name: string) => string | null } | undefined} */
  let last;
  /** @type {typeof globalThis.fetch} */
  const observed = async (url, init) => {
    const response = await fetch(url, init);
    const get = (/** @type {string} */ name) => response.headers.get(name);
    last = { status: response.status, get };
    if (onReading !== undefined) {
      const reading = readingFromHeaders(get, now());
      if (reading !== undefined) {
        try {
          onReading(reading);
        } catch {
          // An observer's failure is not the request's.
        }
      }
    }
    return response;
  };
  return harden({
    fetch: observed,
    /** The last answer's status and headers, or undefined before one. */
    last: () => last,
    /**
     * Whether the last answer was an exhausted refusal (R4-25), by its
     * headers only (the body is never read).
     */
    exhausted: () =>
      last === undefined ? undefined : isExhausted(last.status, last.get),
  });
};
harden(observingFetch);

/**
 * The overload retry of one member attempt (R4-75, R4-105; D-M4-4): the
 * attempt runs again after each delay of `delaysMs` while it fails with a
 * retryable wire failure (an overload before any delivery); any other
 * failure, a delivery, or the end of the schedule ends it. The last failure
 * keeps its pool facts (`exhausted`, `rejected`, `overloaded`) when
 * `withRetries` rewords it as `textOf.afterAttempts`.
 * @param {object} options
 * @param {(signal: AbortSignal) => AsyncIterable<import('../providers/round.js').RoundEvent>} options.attempt
 * @param {readonly number[]} options.delaysMs one delay per retry
 * @param {import('../timers.js').Timers} [options.timers]
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.sleep]
 *   default `sleeperOf(timers)`
 * @param {AbortSignal} options.signal the round's cancel
 * @param {(notice: import('../providers/retry.js').RetryNotice) => void} [options.onRetry]
 * @returns {AsyncGenerator<import('../providers/round.js').RoundEvent, void, undefined>}
 */
export async function* withOverloadRetry({
  attempt,
  delaysMs,
  timers,
  sleep = timers === undefined ? undefined : sleeperOf(timers),
  signal,
  onRetry,
}) {
  if (sleep === undefined) throw TypeError('withOverloadRetry needs a sleep');
  /** @type {unknown} */
  let lastFailure;
  /** @param {AbortSignal} attemptSignal */
  async function* tracked(attemptSignal) {
    try {
      yield* attempt(attemptSignal);
    } catch (error) {
      lastFailure = error;
      throw error;
    }
  }
  try {
    yield* withRetries({
      attempt: tracked,
      maxAttempts: delaysMs.length + 1,
      delayMs: n => delaysMs[Math.min(n, delaysMs.length) - 1] ?? 0,
      sleep,
      signal,
      maxTimeoutRetries: 0,
      ...(onRetry === undefined ? {} : { onRetry }),
    });
  } catch (error) {
    if (
      error instanceof ProviderFailure &&
      error !== lastFailure &&
      lastFailure instanceof ProviderFailure
    ) {
      const from = /** @type {any} */ (lastFailure);
      for (const name of FACTS) {
        if (from[name] !== undefined)
          /** @type {any} */ (error)[name] = from[name];
      }
    }
    throw error;
  }
}
harden(withOverloadRetry);
