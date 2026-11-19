// @ts-check
/**
 * Hook table of the context projection (M1b W1b.2; milestones.md "Hook
 * tables"; designs/m1b-interfaces.md sections 9, 11 and 12).
 *
 * Each entry is `(transcript, { records, texts }) => transcript`, called by
 * `projection.js` in order after the base projection: `transcript` is the
 * array of transcript records (`guest/lib/transcript-records.js` kinds
 * `message`, `tool-call`, `tool-result`, and M8's `compaction` markers)
 * built so far, `records` the session records it was projected from (from
 * the compaction boundary, log order) and `texts` the `Map<Blob, string>`
 * of their staged fields. A hook returns the transcript to pass on (the
 * same array or a new one) and must not mutate `records`. It runs once per
 * round in the adapter process.
 *
 * Append-only: none edits another's entry. M8 (`designs/m8-interfaces.md`
 * 5.5, D-M8-5): `compactionHook` puts the latest summary (and its
 * directive) first and drops every marker; with no marker it answers the
 * transcript unchanged. `providers/compaction.js` imports `projection.js`,
 * which imports this table: the cycle is safe because `compactionHook` is
 * a function declaration (bound before any of the three modules runs).
 */
import { compactionHook } from './providers/compaction.js';

/**
 * @typedef {(transcript: any[], context: { records: readonly any[], texts: Map<any, string> }) => any[]} ProjectionHook
 */

/** @type {readonly ProjectionHook[]} */
export const projectionHooks = harden([compactionHook]);
