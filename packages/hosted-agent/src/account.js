// @ts-check

import { Fail, q } from '@endo/errors';
import { M } from '@endo/patterns';

/**
 * Provider-neutral answers to "what plan is this credential on, how much of the
 * rate limit is left, and what do these tokens cost?".
 *
 * Everything crossing this seam is capability-free data, like the hosted
 * backend descriptors next door: an oracle is meant to be delegable to a UI, a
 * session, or a model without delegating the credential it describes.
 */
export const HostedAccountInterface = M.interface('HostedAccount', {
  getPlan: M.call().returns(M.promise()),
  getRateLimits: M.call().returns(M.promise()),
  getRateCard: M.call().returns(M.promise()),
  estimateCost: M.call(M.record()).returns(M.promise()),
  refresh: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedAccountInterface);

/**
 * Where a snapshot came from.
 *
 * - `observed`   — read from the provider or a hosted backend just now.
 * - `declared`   — the operator's configured profile; true by assertion only.
 * - `remembered` — the last durable observation, replayed after a restart or a
 *   failed refresh. Always paired with an `observedAt` the caller can age.
 * - `unavailable` — nothing is known. Not an error: no provider publishes every
 *   one of these, and a blank answer is more useful than a fabricated one.
 */
const SOURCES = harden(['observed', 'declared', 'remembered', 'unavailable']);

const PLAN_STATES = harden(['active', 'expired', 'unknown']);

/** ISO 4217 alphabetic code. */
const currencyPattern = /^[A-Z]{3}$/;

/**
 * One millionth of a currency unit. Provider list prices are quoted per million
 * tokens and run to fractions of a cent, so they are held as integers of this
 * unit rather than as floating-point money: USD 3.00 per million input tokens
 * is 3_000_000n.
 */
export const MICRO_UNITS_PER_CURRENCY_UNIT = 1_000_000n;

const TOKENS_PER_MILLION = 1_000_000n;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const assertText = (value, label) => {
  (typeof value === 'string' && value.length <= 1024) ||
    Fail`${q(label)} must be a string of at most 1024 characters`;
  return /** @type {string} */ (value);
};

/**
 * An ISO 8601 instant, or the empty string for "not published".
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const assertInstant = (value, label) => {
  const text = assertText(value, label);
  if (text === '') return '';
  Number.isFinite(Date.parse(text)) ||
    Fail`${q(label)} must be an ISO 8601 instant or empty`;
  return text;
};

/**
 * A quantity of requests or tokens, or null for "not published".
 *
 * `bigint`, because a published quota is a natural number whose range is the
 * provider's to choose: monthly token allowances already run past what four
 * bytes hold, and there is no reason to narrow one to a JavaScript float.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {bigint | null}
 */
const assertCount = (value, label) => {
  if (value === null || value === undefined) return null;
  typeof value === 'bigint' ||
    Fail`${q(label)} must be a bigint or null, not ${q(typeof value)}`;
  const count = /** @type {bigint} */ (value);
  count >= 0n || Fail`${q(label)} must not be negative`;
  return count;
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const assertSource = (value, label) => {
  SOURCES.includes(/** @type {any} */ (value)) ||
    Fail`${q(label)} must be one of ${q(SOURCES)}`;
  return /** @type {string} */ (value);
};

/**
 * Validate and project a subscription-plan snapshot.
 *
 * @param {any} candidate
 */
export const normalizeAccountPlan = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Account plan must be a record`;
  PLAN_STATES.includes(candidate.state) ||
    Fail`Account plan state must be one of ${q(PLAN_STATES)}`;
  return harden({
    providerId: assertText(candidate.providerId, 'providerId'),
    planId: assertText(candidate.planId ?? '', 'planId'),
    title: assertText(candidate.title ?? '', 'title'),
    state: candidate.state,
    renewsAt: assertInstant(candidate.renewsAt ?? '', 'renewsAt'),
    seats: assertCount(candidate.seats, 'seats'),
    observedAt: assertInstant(candidate.observedAt, 'observedAt'),
    source: assertSource(candidate.source, 'plan source'),
  });
};
harden(normalizeAccountPlan);

/**
 * Validate and project one rate-limit window.
 *
 * `used`, `remaining`, and `limit` are each independently optional because
 * providers publish different subsets; `usedFraction` is derived only when the
 * pair it needs is present, so a caller never has to guess whether a zero means
 * "none used" or "not published".
 *
 * @param {any} candidate
 */
export const normalizeRateLimitWindow = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Rate limit window must be a record`;
  const windowId = assertText(candidate.windowId, 'windowId');
  windowId !== '' || Fail`Rate limit window must have a windowId`;
  const limit = assertCount(candidate.limit, 'limit');
  const used = assertCount(candidate.used, 'used');
  let remaining = assertCount(candidate.remaining, 'remaining');
  if (remaining === null && limit !== null && used !== null) {
    remaining = used > limit ? 0n : limit - used;
  }
  let usedFraction = null;
  if (limit !== null && limit > 0n && used !== null) {
    // A ratio, not a count: expressed as a float in [0, 1] so a caller can
    // render a percentage without re-deriving it from two bigints.
    usedFraction = Number(used) / Number(limit);
    if (usedFraction > 1) usedFraction = 1;
  }
  return harden({
    windowId,
    title: assertText(candidate.title ?? '', 'title'),
    limit,
    used,
    remaining,
    usedFraction,
    resetsAt: assertInstant(candidate.resetsAt ?? '', 'resetsAt'),
  });
};
harden(normalizeRateLimitWindow);

/**
 * Validate and project a rate-limit snapshot.
 *
 * @param {any} candidate
 */
export const normalizeRateLimits = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Rate limits must be a record`;
  const windows = candidate.windows;
  (Array.isArray(windows) && windows.length <= 64) ||
    Fail`Rate limits must carry at most 64 windows`;
  const projected = windows.map(normalizeRateLimitWindow);
  new Set(projected.map(entry => entry.windowId)).size === projected.length ||
    Fail`Rate limit windows must have distinct ids`;
  return harden({
    windows: harden(projected),
    observedAt: assertInstant(candidate.observedAt, 'observedAt'),
    source: assertSource(candidate.source, 'rate limit source'),
  });
};
harden(normalizeRateLimits);

/**
 * Validate and project one model's list price.
 *
 * @param {any} candidate
 */
export const normalizeModelRate = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Model rate must be a record`;
  const modelId = assertText(candidate.modelId, 'modelId');
  modelId !== '' || Fail`Model rate must name a model`;
  const currency = assertText(candidate.currency, 'currency');
  currencyPattern.test(currency) ||
    Fail`Model rate currency must be an ISO 4217 alphabetic code`;
  return harden({
    modelId,
    currency,
    inputPerMillion: assertCount(candidate.inputPerMillion, 'inputPerMillion'),
    outputPerMillion: assertCount(
      candidate.outputPerMillion,
      'outputPerMillion',
    ),
    cachedInputPerMillion: assertCount(
      candidate.cachedInputPerMillion,
      'cachedInputPerMillion',
    ),
    effectiveAt: assertInstant(candidate.effectiveAt ?? '', 'effectiveAt'),
  });
};
harden(normalizeModelRate);

/**
 * Validate and project a rate card.
 *
 * @param {any} candidate
 */
export const normalizeRateCard = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Rate card must be a record`;
  const rates = candidate.rates;
  (Array.isArray(rates) && rates.length <= 256) ||
    Fail`Rate card must carry at most 256 model rates`;
  const projected = rates.map(normalizeModelRate);
  new Set(projected.map(entry => entry.modelId)).size === projected.length ||
    Fail`Rate card must not price a model twice`;
  return harden({
    rates: harden(projected),
    observedAt: assertInstant(candidate.observedAt, 'observedAt'),
    source: assertSource(candidate.source, 'rate card source'),
  });
};
harden(normalizeRateCard);

/**
 * Cost of a token count at a list price, in micro-units of the rate's currency.
 *
 * Integer arithmetic throughout, truncated toward zero at the micro-unit: the
 * result is an estimate against a published list price, and a fraction of a
 * millionth of a cent is not information anyone can act on. A price the rate
 * card does not publish contributes nothing and is reported in `missing`, so a
 * caller can tell "free" from "unpriced".
 *
 * @param {object} usage
 * @param {bigint} [usage.inputTokens]
 * @param {bigint} [usage.outputTokens]
 * @param {bigint} [usage.cachedInputTokens]
 * @param {ReturnType<typeof normalizeModelRate> | undefined} rate
 * @returns {{ currency: string, microUnits: bigint, missing: string[] }}
 */
export const estimateCostAtRate = (usage, rate) => {
  if (rate === undefined) {
    return harden({ currency: '', microUnits: 0n, missing: harden(['rate']) });
  }
  /** @type {string[]} */
  const missing = [];
  let microUnits = 0n;
  /**
   * @param {bigint | undefined} tokens
   * @param {bigint | null} perMillion
   * @param {string} label
   */
  const add = (tokens, perMillion, label) => {
    const count = tokens ?? 0n;
    typeof count === 'bigint' ||
      Fail`${q(label)} token count must be a bigint, not ${q(typeof tokens)}`;
    count >= 0n || Fail`${q(label)} token count must not be negative`;
    if (count === 0n) return;
    if (perMillion === null) {
      missing.push(label);
      return;
    }
    microUnits += (count * perMillion) / TOKENS_PER_MILLION;
  };
  add(usage.inputTokens, rate.inputPerMillion, 'input');
  add(usage.outputTokens, rate.outputPerMillion, 'output');
  add(usage.cachedInputTokens, rate.cachedInputPerMillion, 'cachedInput');
  return harden({
    currency: rate.currency,
    microUnits,
    missing: harden(missing),
  });
};
harden(estimateCostAtRate);

/**
 * Render micro-units as a decimal amount for display. Never used for
 * arithmetic — the exact value is the bigint.
 *
 * @param {bigint} microUnits
 * @param {string} currency
 * @returns {string}
 */
export const formatMicroUnits = (microUnits, currency) => {
  const negative = microUnits < 0n;
  const magnitude = negative ? -microUnits : microUnits;
  const whole = magnitude / MICRO_UNITS_PER_CURRENCY_UNIT;
  const fraction = magnitude % MICRO_UNITS_PER_CURRENCY_UNIT;
  const text = `${whole}.${`${fraction}`.padStart(6, '0')}`;
  return `${negative ? '-' : ''}${text}${currency ? ` ${currency}` : ''}`;
};
harden(formatMicroUnits);

/**
 * Convert a JSON-shaped declared profile into the passable record the
 * normalizers expect.
 *
 * JSON has no bigint, so an operator writes quotas and prices as numbers or
 * decimal strings and this widens them. A number that is not an exact integer
 * is rejected rather than rounded: a quota silently changed by float parsing is
 * worse than a configuration error.
 *
 * @param {any} json
 */
export const coerceDeclaredProfile = json => {
  /**
   * @param {unknown} value
   * @param {string} label
   * @returns {bigint | null}
   */
  const toCount = (value, label) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      Number.isSafeInteger(value) ||
        Fail`${q(label)} must be written as a string when it is not an exact JSON integer`;
      return BigInt(value);
    }
    if (typeof value === 'string') {
      /^(0|[1-9][0-9]*)$/.test(value) ||
        Fail`${q(label)} must be a non-negative decimal integer`;
      return BigInt(value);
    }
    throw Fail`${q(label)} must be a number, a decimal string, or null`;
  };
  (json && typeof json === 'object') ||
    Fail`Declared account profile must be a record`;
  /** @type {any} */
  const profile = {};
  if (json.plan) {
    profile.plan = {
      ...json.plan,
      seats: toCount(json.plan.seats, 'plan.seats'),
    };
  }
  if (json.rateLimits) {
    const windows = /** @type {any[]} */ (json.rateLimits.windows);
    (Array.isArray(windows) && windows.length <= 64) ||
      Fail`Declared rate limits must carry at most 64 windows`;
    profile.rateLimits = {
      ...json.rateLimits,
      windows: windows.map((entry, index) => ({
        ...entry,
        limit: toCount(entry.limit, `rateLimits.windows[${index}].limit`),
        used: toCount(entry.used, `rateLimits.windows[${index}].used`),
        remaining: toCount(
          entry.remaining,
          `rateLimits.windows[${index}].remaining`,
        ),
      })),
    };
  }
  if (json.rateCard) {
    const rates = /** @type {any[]} */ (json.rateCard.rates);
    (Array.isArray(rates) && rates.length <= 256) ||
      Fail`Declared rate card must carry at most 256 model rates`;
    profile.rateCard = {
      ...json.rateCard,
      rates: rates.map((entry, index) => ({
        ...entry,
        inputPerMillion: toCount(
          entry.inputPerMillion,
          `rateCard.rates[${index}].inputPerMillion`,
        ),
        outputPerMillion: toCount(
          entry.outputPerMillion,
          `rateCard.rates[${index}].outputPerMillion`,
        ),
        cachedInputPerMillion: toCount(
          entry.cachedInputPerMillion,
          `rateCard.rates[${index}].cachedInputPerMillion`,
        ),
      })),
    };
  }
  return harden(profile);
};
harden(coerceDeclaredProfile);

/**
 * An answer for a provider that publishes nothing.
 *
 * @param {string} providerId
 * @param {string} observedAt
 */
export const unknownPlan = (providerId, observedAt) =>
  normalizeAccountPlan({
    providerId,
    planId: '',
    title: '',
    state: 'unknown',
    renewsAt: '',
    seats: null,
    observedAt,
    source: 'unavailable',
  });
harden(unknownPlan);

/** @param {string} observedAt */
export const unknownRateLimits = observedAt =>
  normalizeRateLimits({ windows: [], observedAt, source: 'unavailable' });
harden(unknownRateLimits);

/** @param {string} observedAt */
export const unknownRateCard = observedAt =>
  normalizeRateCard({ rates: [], observedAt, source: 'unavailable' });
harden(unknownRateCard);
