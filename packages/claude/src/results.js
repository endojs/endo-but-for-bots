// @ts-check
//
// The `infer` result taxonomy (Design Decision 8). Every value crossing the
// CapTP boundary is not merely `harden`ed but PASSABLE: `harden` freezes, it does
// not make a value passable, so `facet-threw` carries `toPassableError(caught)`,
// never the raw caught value (a non-Error, an Error with extra own properties, a
// proxy — all of which `passStyleOf` rejects), and `usage` is a copyRecord of
// primitives. Otherwise the guarded `M.promise()` return would throw a
// marshalling error in exactly the failure case the taxonomy exists to report.

import { makeError, X, q } from '@endo/errors';
import { toPassableError } from '@endo/pass-style';

/**
 * @typedef {{ type: 'ok', text: string, usage: Readonly<Record<string, number | string>> }} OkResult
 * @typedef {{ type: 'rate-limited', retryAfterMs?: number }} RateLimitedResult
 * @typedef {{ type: 'pool-exhausted', retryAfterMs?: number }} PoolExhaustedResult
 * @typedef {{ type: 'bridge-down', detail: string }} BridgeDownResult
 * @typedef {{ type: 'facet-threw', method: string, error: Error }} FacetThrewResult
 * @typedef {{ type: 'nonzero-exit', code: number }} NonzeroExitResult
 * @typedef {{ type: 'parse-error', detail: string }} ParseErrorResult
 * @typedef {{ type: 'limit-exceeded', which: 'wall-clock' | 'output-bytes' | 'max-turns' }} LimitExceededResult
 * @typedef {{ type: 'cancelled', at: 'before-spawn' | 'mid-stream' | 'after-exit' }} CancelledResult
 *
 * @typedef {OkResult | RateLimitedResult | PoolExhaustedResult | BridgeDownResult
 *   | FacetThrewResult | NonzeroExitResult | ParseErrorResult | LimitExceededResult
 *   | CancelledResult} InferResult
 */

/** The exhaustive set of `type` discriminants, for validation and tests. */
export const INFER_RESULT_TYPES = harden([
  'ok',
  'rate-limited',
  'pool-exhausted',
  'bridge-down',
  'facet-threw',
  'nonzero-exit',
  'parse-error',
  'limit-exceeded',
  'cancelled',
]);

/**
 * @param {string} text
 * @param {Record<string, number | string>} [usage]
 * @returns {OkResult}
 */
export const ok = (text, usage = {}) => {
  if (typeof text !== 'string') {
    throw makeError(X`ok result text must be a string`);
  }
  // `usage` is a copyRecord of primitives; reject anything that would not
  // marshal. A copyRecord must be `Object.prototype`-based (a null-prototype
  // object is treated as a remotable and rejected for its non-method data
  // properties), so build it as a plain object, not `Object.create(null)`.
  /** @type {Record<string, number | string>} */
  const cleanUsage = {};
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v !== 'number' && typeof v !== 'string') {
      throw makeError(X`ok result usage.${q(k)} must be a number or string`);
    }
    cleanUsage[k] = v;
  }
  return harden({ type: 'ok', text, usage: harden(cleanUsage) });
};
harden(ok);

/**
 * @param {number} [retryAfterMs]
 * @returns {RateLimitedResult}
 */
export const rateLimited = retryAfterMs =>
  harden(
    retryAfterMs === undefined
      ? { type: 'rate-limited' }
      : { type: 'rate-limited', retryAfterMs },
  );
harden(rateLimited);

/**
 * @param {number} [retryAfterMs]
 * @returns {PoolExhaustedResult}
 */
export const poolExhausted = retryAfterMs =>
  harden(
    retryAfterMs === undefined
      ? { type: 'pool-exhausted' }
      : { type: 'pool-exhausted', retryAfterMs },
  );
harden(poolExhausted);

/**
 * @param {string} detail
 * @returns {BridgeDownResult}
 */
export const bridgeDown = detail =>
  harden({ type: 'bridge-down', detail: String(detail) });
harden(bridgeDown);

/**
 * @param {string} method
 * @param {unknown} caught
 * @returns {FacetThrewResult}
 */
export const facetThrew = (method, caught) =>
  harden({
    type: 'facet-threw',
    method: String(method),
    // toPassableError normalizes any thrown value into a passable error.
    error: toPassableError(
      caught instanceof Error ? caught : makeError(X`${q(caught)}`),
    ),
  });
harden(facetThrew);

/**
 * @param {number} code
 * @returns {NonzeroExitResult}
 */
export const nonzeroExit = code =>
  harden({ type: 'nonzero-exit', code: Number(code) });
harden(nonzeroExit);

/**
 * @param {string} detail
 * @returns {ParseErrorResult}
 */
export const parseError = detail =>
  harden({ type: 'parse-error', detail: String(detail) });
harden(parseError);

/**
 * @param {'wall-clock' | 'output-bytes' | 'max-turns'} which
 * @returns {LimitExceededResult}
 */
export const limitExceeded = which => {
  if (
    which !== 'wall-clock' &&
    which !== 'output-bytes' &&
    which !== 'max-turns'
  ) {
    throw makeError(X`limit-exceeded: unknown axis ${q(which)}`);
  }
  return harden({ type: 'limit-exceeded', which });
};
harden(limitExceeded);

/**
 * @param {'before-spawn' | 'mid-stream' | 'after-exit'} at
 * @returns {CancelledResult}
 */
export const cancelled = at => {
  if (at !== 'before-spawn' && at !== 'mid-stream' && at !== 'after-exit') {
    throw makeError(X`cancelled: unknown phase ${q(at)}`);
  }
  return harden({ type: 'cancelled', at });
};
harden(cancelled);
