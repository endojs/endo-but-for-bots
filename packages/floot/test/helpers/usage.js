// @ts-check

/**
 * The five disjoint token counts a usage record carries, with the ones a test
 * does not mention at 0, so a test states what it means and not the whole
 * shape. Anything else given (`turns`, `context`, `type`) is kept.
 *
 * @param {Record<string, unknown>} given
 */
export const usageCounts = given => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  ...given,
});
