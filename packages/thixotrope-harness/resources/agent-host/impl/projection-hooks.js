// @ts-check
/**
 * Hook table of the context projection (M1b W1b.2; milestones.md "Hook
 * tables"; designs/m1b-interfaces.md sections 9, 11 and 12).
 *
 * Each entry is `(transcript, { records, texts }) => transcript`, called by
 * `projection.js` in order after the base projection: `transcript` is the
 * array of transcript records (`guest/lib/transcript-records.js` kinds
 * `message`, `tool-call`, `tool-result`) built so far, `records` the session
 * records it was projected from (from the compaction boundary, log order)
 * and `texts` the `Map<Blob, string>` of their staged fields. A hook returns
 * the transcript to pass on (the same array or a new one) and must not
 * mutate `records`. It runs once per round in the adapter process.
 *
 * Append-only: M8 (compaction) adds its entry here; none edits another's
 * entry. M1b has none.
 */

/**
 * @typedef {(transcript: any[], context: { records: readonly any[], texts: Map<any, string> }) => any[]} ProjectionHook
 */

/** @type {readonly ProjectionHook[]} */
export const projectionHooks = harden([]);
