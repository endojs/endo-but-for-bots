// Type definitions for the hashline edit-patch envelope.
//
// These types are the wire contract for `EndoGuest.edit` and
// `EndoDirectory.edit`, per `designs/cli-edit-verb.md`. They land first
// so the implementation in `hashline.js` and the daemon-side splice can
// import them as Phase 1 of the design's phased rollout. The runtime
// implementation is stubbed in `hashline.js` and rejects with
// `not_implemented` until Phase 2.

/**
 * One anchor in an edit operation: a 1-indexed line number paired with
 * a short content-hash of the line at that position.
 *
 * The hash is CRC32 of the normalized line, rendered as lowercase hex.
 * Anchors carry their own width (2 chars for files ≤4096 lines, 4 chars
 * for larger files); the daemon validator recomputes the live line's
 * CRC at the patch's declared width for the comparison.
 */
export interface Anchor {
  line: number;
  hash: string;
}

/**
 * The supported operation discriminator.
 */
export type EditOpKind =
  | 'replace'
  | 'replace-range'
  | 'delete'
  | 'insert-after'
  | 'insert-before'
  | 'prepend'
  | 'append';

/**
 * One operation within a patch envelope.
 *
 * Non-range ops carry a single `anchor`; range ops carry `anchor` and
 * `anchorEnd`. `prepend` and `append` carry no anchor. `payload` is an
 * array of bare line contents (no embedded LF); the splice joins them
 * with LF on insert.
 */
export interface EditOp {
  op: EditOpKind;
  anchor?: Anchor;
  anchorEnd?: Anchor;
  payload?: string[];
}

/**
 * The full patch envelope. The wire shape is plain JSON; CapTP delivers
 * it as a pass-by-copy record but callers must not rely on hardened
 * identity round-tripping.
 *
 * `expectedFileHash` is the SHA-256 of the file as the agent read it,
 * rendered as 64-char lowercase hex. The daemon CAS-checks against the
 * live file before splicing.
 */
export interface EditPatch {
  expectedFileHash: string;
  ops: EditOp[];
}

/**
 * Options accepted by `EndoDirectory.edit` / `EndoGuest.edit`.
 */
export interface EditOptions {
  reapply?: boolean;
  reapplyWindow?: number;
}

/**
 * Failure-reason discriminator for the structured failure result.
 */
export type EditFailureReason =
  | 'hash-mismatch'
  | 'file-rev-mismatch'
  | 'ambiguous-reapply'
  | 'patch-syntax'
  | 'path-not-found'
  | 'permission-denied';

/**
 * One mismatching per-line anchor, reported back in the `hash-mismatch`
 * failure shape so the agent can inspect and re-author.
 *
 * `hashActualAtPatchWidth` and `hashActualAtFileWidth` are both
 * supplied so an agent that hand-edits the patch can see both the
 * width its patch declared and the file's currently-native width.
 */
export interface AnchorMismatch {
  line: number;
  hashExpected: string;
  hashActualAtPatchWidth: string;
  hashActualAtFileWidth: string;
}

/**
 * The structured failure populated when `success` is false.
 */
export interface EditFailure {
  reason: EditFailureReason;
  fileHashActual?: string;
  mismatches?: AnchorMismatch[];
  candidates?: number[];
  diagnostic?: string;
}

/**
 * The result of an `edit` call. The result is a value, not a thrown
 * error, so the agent can inspect `failure.reason` without unwrapping
 * a thrown error across the eventual-send boundary.
 */
export interface EditResult {
  success: boolean;
  fileHashAfter?: string;
  failure?: EditFailure;
}

/**
 * One entry in the future `editBatch` multi-file API (Phase 4).
 *
 * `directoryRef` is intentionally typed as `unknown` here because the
 * `EndoDirectory` interface is declared elsewhere; the runtime checks
 * the capability guard on entry to the daemon's edit method.
 */
export interface EditBatchEntry {
  directoryRef: unknown;
  path: string;
  patch: EditPatch;
}

/**
 * The result of an `editBatch` call. Either every entry succeeded, or
 * every entry was left unmutated and the first failing entry's index
 * and failure are reported.
 */
export interface EditBatchResult {
  success: boolean;
  results?: EditResult[];
  failureIndex?: number;
  failure?: EditFailure;
}

/**
 * Pure-function shape of the line-split helper. The splice preserves
 * `trailingNewline` byte-for-byte through the read-validate-splice-
 * write sequence.
 */
export interface SplitLinesResult {
  lines: string[];
  trailingNewline: boolean;
}
