// @ts-check
/**
 * The session's usage arithmetic (R4-33; `designs/m2-interfaces.md` 12,
 * "usage rules"): one place for the two rules the session vat applies to
 * every reported reading.
 *
 * - Counts add, by named key (guest rule no-data-keys, J-9366):
 *   `addCounts(into, next)`.
 * - The context reading is whole: the latest reading replaces the previous
 *   one (used and window together), and a session whose catalogue entry
 *   gave a context length shows that window instead of the provider's:
 *   `sessionContext(reading, contextLength)`.
 *
 * The adapter's `token-usage.js` `addUsage` keeps its own rule on purpose
 * (field by field, a 0 never replaces a known figure, counts capped): it
 * merges provider frames, not settled rounds. `journal-usage.js` restates
 * these rules independently as the test oracle.
 *
 * Vat and Node; plain values.
 */

/** The five counts, all zero. */
export const zeroCounts = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
harden(zeroCounts);

/**
 * Add `next`'s five counts into `into` (mutated).
 * @param {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, reasoningOutputTokens: number }} into
 * @param {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, reasoningOutputTokens: number }} next
 */
export const addCounts = (into, next) => {
  into.inputTokens += next.inputTokens;
  into.outputTokens += next.outputTokens;
  into.cachedInputTokens += next.cachedInputTokens;
  into.cacheWriteInputTokens += next.cacheWriteInputTokens;
  into.reasoningOutputTokens += next.reasoningOutputTokens;
};
harden(addCounts);

/**
 * The session's view of a context reading (R4-33): the reading whole, with
 * the catalogue's window when the session stored one at creation.
 * @param {{ usedTokens: number, windowTokens: number }} reading
 * @param {number | undefined} contextLength
 */
export const sessionContext = (reading, contextLength) =>
  contextLength === undefined
    ? reading
    : { ...reading, windowTokens: contextLength };
harden(sessionContext);
