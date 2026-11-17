// @ts-check
/**
 * Token usage in the harness's `Usage` shape (M2 W2.1a; R4-33;
 * designs/m2-interfaces.md 10, 12). Adapted from Endo hosted-agent
 * `src/token-usage.js` (`tokenCount`, `emptyCounts`, `addUsage`) and the
 * provider conversions of lal `providers/openrouter.js`
 * (`usageFromOpenRouter`) and hosted-agent `src/provider-usage.js`
 * (Anthropic's counts).
 *
 * The five counts are disjoint: a token is in exactly one of them.
 * OpenRouter follows the OpenAI convention (`prompt_tokens` includes the
 * cached ones, `completion_tokens` the reasoning ones), so it is converted;
 * Anthropic's `input_tokens` already excludes cache reads and writes and
 * it has no reasoning count. `context` is what the request put in the
 * window (every input kind plus the output) with the window size the
 * caller knows (0 when unknown; the session sets it from its config, seam 3
 * of m2-interfaces.md 2.4). A count that does not parse is 0: usage is an
 * observation and a malformed one must not fail the turn it describes.
 *
 * Vat and Node (guest rules: prelude globals only, fixed record keys).
 */

const MAX_COUNT = 9_007_199_254_740_991;

/**
 * A non-negative safe integer, or 0 (numbers and decimal strings only).
 * @param {unknown} value
 */
export const tokenCount = value => {
  let number = 0;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))
    number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.trunc(number), MAX_COUNT);
};
harden(tokenCount);

/** Zero usage (no context reading). */
export const emptyUsage = () =>
  harden({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
harden(emptyUsage);

/**
 * @param {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, reasoningOutputTokens: number }} counts
 * @param {number} windowTokens
 */
const withContext = (counts, windowTokens) => {
  const used = Math.min(
    counts.inputTokens +
      counts.outputTokens +
      counts.cachedInputTokens +
      counts.cacheWriteInputTokens +
      counts.reasoningOutputTokens,
    MAX_COUNT,
  );
  const window = tokenCount(windowTokens);
  if (used === 0 && window === 0) return harden(counts);
  return harden({
    ...counts,
    context: harden({ usedTokens: used, windowTokens: window }),
  });
};

/**
 * OpenRouter's (OpenAI-style) `usage` object as disjoint counts.
 * @param {any} raw
 * @param {number} [windowTokens]
 */
export const usageFromOpenRouter = (raw, windowTokens = 0) => {
  const usage = raw !== null && typeof raw === 'object' ? raw : {};
  const prompt = tokenCount(usage.prompt_tokens);
  const completion = tokenCount(usage.completion_tokens);
  const cached = Math.min(
    prompt,
    tokenCount(usage.prompt_tokens_details?.cached_tokens),
  );
  const reasoning = Math.min(
    completion,
    tokenCount(usage.completion_tokens_details?.reasoning_tokens),
  );
  return withContext(
    {
      inputTokens: prompt - cached,
      outputTokens: completion - reasoning,
      cachedInputTokens: cached,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: reasoning,
    },
    windowTokens,
  );
};
harden(usageFromOpenRouter);

/**
 * Anthropic's `usage` object (Messages API) as disjoint counts.
 * @param {any} raw
 * @param {number} [windowTokens]
 */
export const usageFromAnthropic = (raw, windowTokens = 0) => {
  const usage = raw !== null && typeof raw === 'object' ? raw : {};
  return withContext(
    {
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheWriteInputTokens: tokenCount(usage.cache_creation_input_tokens),
      reasoningOutputTokens: 0,
    },
    windowTokens,
  );
};
harden(usageFromAnthropic);

/**
 * Counts add; the newer context reading wins field by field, and a 0 never
 * replaces a known figure (hosted-agent `mergeContext`).
 * @param {any} sum
 * @param {any} next
 */
export const addUsage = (sum, next) => {
  const a = sum ?? {};
  const b = next ?? {};
  /** @param {string} key */
  const add = key =>
    Math.min(tokenCount(a[key]) + tokenCount(b[key]), MAX_COUNT);
  const counts = {
    inputTokens: add('inputTokens'),
    outputTokens: add('outputTokens'),
    cachedInputTokens: add('cachedInputTokens'),
    cacheWriteInputTokens: add('cacheWriteInputTokens'),
    reasoningOutputTokens: add('reasoningOutputTokens'),
  };
  const ca = a.context;
  const cb = b.context;
  if (ca === undefined && cb === undefined) return harden(counts);
  const usedTokens = tokenCount(cb?.usedTokens) || tokenCount(ca?.usedTokens);
  const windowTokens =
    tokenCount(cb?.windowTokens) || tokenCount(ca?.windowTokens);
  return harden({
    ...counts,
    context: harden({ usedTokens, windowTokens }),
  });
};
harden(addUsage);
