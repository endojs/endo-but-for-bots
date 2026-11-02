// @ts-check

/**
 * Token usage as every hosted adapter and Floot's own provider path report
 * it, and the arithmetic on it.
 *
 * The five counts are **disjoint**: a token is in exactly one of them, so
 * their sum is the traffic and nothing is counted twice. Providers do not
 * agree on this (OpenAI's `input_tokens` includes the cached ones, Anthropic's
 * excludes them), so each adapter converts before it reports.
 *
 * - `inputTokens`: input that was neither read from nor written to a cache.
 * - `cachedInputTokens`: input read from the provider's prompt cache.
 * - `cacheWriteInputTokens`: input written to it.
 * - `outputTokens`: output that is not reasoning.
 * - `reasoningOutputTokens`: reasoning output.
 *
 * `context` is what the **last request** put in the model's window, every
 * input kind plus that request's output (the output joins the conversation),
 * beside the window's size. It is a reading, not a sum: the latest one wins,
 * field by field. Either field is 0 when the backend did not say, and a 0
 * never replaces a figure already known: some backends learn the window's
 * size only when a turn ends, and a turn that failed may report the size and
 * no request. The cost of that rule is that a session whose model changes to
 * one that never reports a size keeps showing the previous model's.
 *
 * Everything here is a plain number. A count that does not parse is 0 rather
 * than an error: usage is an observation, and a malformed one must not fail
 * the turn it describes.
 *
 * @module
 */

export const USAGE_COUNT_KEYS = harden(
  /** @type {const} */ ([
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'reasoningOutputTokens',
  ]),
);

/**
 * @typedef {object} TokenCounts
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedInputTokens
 * @property {number} cacheWriteInputTokens
 * @property {number} reasoningOutputTokens
 */

/**
 * @typedef {object} ContextReading
 * @property {number} usedTokens
 * @property {number} windowTokens 0 when unknown
 */

/** @typedef {TokenCounts & { context?: ContextReading }} TokenUsage */

/**
 * A non-negative safe integer, or 0.
 *
 * @param {unknown} value
 */
export const tokenCount = value => {
  // Numbers, bigints and decimal strings only: `Number()` would also take
  // `true`, `'0x10'` and `[5]`, and would throw on a symbol.
  let number = 0;
  if (typeof value === 'number' || typeof value === 'bigint') {
    number = Number(value);
  } else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
    number = Number(value);
  }
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
};
harden(tokenCount);

/**
 * @param {unknown} candidate
 * @returns {ContextReading | undefined} undefined when nothing was read
 */
export const projectContext = candidate => {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (candidate);
  const usedTokens = tokenCount(record.usedTokens);
  const windowTokens = tokenCount(record.windowTokens);
  if (usedTokens === 0 && windowTokens === 0) return undefined;
  return harden({ usedTokens, windowTokens });
};
harden(projectContext);

/**
 * The newer reading over the older, field by field; a field the newer one
 * does not know keeps the older figure.
 *
 * @param {unknown} older
 * @param {unknown} newer
 * @returns {ContextReading | undefined}
 */
export const mergeContext = (older, newer) => {
  const a = projectContext(older);
  const b = projectContext(newer);
  if (a === undefined || b === undefined) return b ?? a;
  return harden({
    usedTokens: b.usedTokens || a.usedTokens,
    windowTokens: b.windowTokens || a.windowTokens,
  });
};
harden(mergeContext);

/** @returns {TokenCounts} */
export const emptyCounts = () =>
  harden({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
harden(emptyCounts);

/**
 * Keep the counts and the context of anything usage-shaped, and nothing else.
 * A record written before the three newer counts existed reads them as 0.
 *
 * @param {unknown} candidate
 * @returns {TokenUsage}
 */
export const projectUsage = candidate => {
  const record = /** @type {Record<string, unknown>} */ (
    candidate !== null && typeof candidate === 'object' ? candidate : {}
  );
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of USAGE_COUNT_KEYS) counts[key] = tokenCount(record[key]);
  const context = projectContext(record.context);
  return harden(
    /** @type {TokenUsage} */ ({
      ...counts,
      ...(context === undefined ? {} : { context }),
    }),
  );
};
harden(projectUsage);

/**
 * Counts add; the context of `next` is merged over `sum`'s (`mergeContext`).
 *
 * @param {unknown} sum
 * @param {unknown} next
 * @returns {TokenUsage}
 */
export const addUsage = (sum, next) => {
  const a = projectUsage(sum);
  const b = projectUsage(next);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of USAGE_COUNT_KEYS) {
    counts[key] = Math.min(a[key] + b[key], Number.MAX_SAFE_INTEGER);
  }
  const context = mergeContext(a.context, b.context);
  return harden(
    /** @type {TokenUsage} */ ({
      ...counts,
      ...(context === undefined ? {} : { context }),
    }),
  );
};
harden(addUsage);

/**
 * Every token of the five kinds.
 *
 * @param {unknown} usage
 */
export const totalTokens = usage => {
  const counts = projectUsage(usage);
  let total = 0;
  for (const key of USAGE_COUNT_KEYS) total += counts[key];
  return Math.min(total, Number.MAX_SAFE_INTEGER);
};
harden(totalTokens);

/**
 * How full the window is, from 0 to 1, or null when the window's size is not
 * known. A conversation that has outgrown what the backend said reads as 1.
 *
 * @param {unknown} context
 */
export const contextFraction = context => {
  const reading = projectContext(context);
  if (reading === undefined || reading.windowTokens === 0) return null;
  return Math.min(1, reading.usedTokens / reading.windowTokens);
};
harden(contextFraction);

/**
 * Convert a breakdown whose cached, cache-write and reasoning counts are
 * **subsets** of its input and output counts (the OpenAI convention) into
 * disjoint counts. Anything that would go negative is 0.
 *
 * @param {object} breakdown
 * @param {unknown} breakdown.inputTokens all input, cached included
 * @param {unknown} breakdown.outputTokens all output, reasoning included
 * @param {unknown} [breakdown.cachedInputTokens]
 * @param {unknown} [breakdown.cacheWriteInputTokens] counted inside
 *   `inputTokens` only when `cacheWriteInsideInput` says so
 * @param {unknown} [breakdown.reasoningOutputTokens]
 * @param {boolean} [breakdown.cacheWriteInsideInput]
 * @returns {TokenCounts}
 */
export const disjointFromInclusive = ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  reasoningOutputTokens,
  cacheWriteInsideInput = false,
}) => {
  const cached = tokenCount(cachedInputTokens);
  const written = tokenCount(cacheWriteInputTokens);
  const reasoning = tokenCount(reasoningOutputTokens);
  const inside = cached + (cacheWriteInsideInput ? written : 0);
  return harden({
    inputTokens: Math.max(0, tokenCount(inputTokens) - inside),
    outputTokens: Math.max(0, tokenCount(outputTokens) - reasoning),
    cachedInputTokens: cached,
    cacheWriteInputTokens: written,
    reasoningOutputTokens: reasoning,
  });
};
harden(disjointFromInclusive);

/**
 * Usage as the account oracle's `estimateCost` prices it, in `bigint`. A rate
 * card has an input rate, a cached-input rate and an output rate: cache writes
 * are priced as input (they cost at least that) and reasoning as output.
 *
 * @param {unknown} usage
 */
export const priceableUsage = usage => {
  const counts = projectUsage(usage);
  return harden({
    inputTokens: BigInt(counts.inputTokens + counts.cacheWriteInputTokens),
    cachedInputTokens: BigInt(counts.cachedInputTokens),
    outputTokens: BigInt(counts.outputTokens + counts.reasoningOutputTokens),
  });
};
harden(priceableUsage);
