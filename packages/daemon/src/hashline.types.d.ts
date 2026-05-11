/**
 * Type definitions for the `EndoGuest.edit` capability and the
 * hashline patch envelope.
 *
 * Per design `cli-edit-verb.md` §"Patch envelope shape" and
 * §"Result shape".
 */

/** Discriminant for an edit operation. Kebab-case per design. */
export type EditOpKind =
  | 'replace'
  | 'replace-range'
  | 'delete'
  | 'insert-after'
  | 'insert-before'
  | 'prepend'
  | 'append';

/** A line anchor: 1-indexed line number plus its short content hash. */
export interface Anchor {
  /** 1-indexed line number. */
  line: number;
  /** 2-to-4 char lowercase hex per CRC32 anchor algorithm. */
  hash: string;
}

/** A single edit operation. */
export interface EditOp {
  op: EditOpKind;
  /** One anchor for non-range ops; absent for prepend/append. */
  anchor?: Anchor;
  /** Second anchor for range ops (replace-range, delete-range). */
  anchorEnd?: Anchor;
  /** Inserted lines (LF terminator implied between adjacent lines). */
  payload?: string[];
}

/** A patch envelope (the canonical `hashline-json` wire shape). */
export interface EditPatch {
  /**
   * SHA-256 of the file the agent read, as 64-char lowercase hex.
   * The CAS check, regardless of any underlying content store's
   * native digest.
   */
  expectedFileHash: string;
  /**
   * Operations in any order; sorted bottom-up by line number before
   * splicing. Per-line anchor hashes are CRC32; algorithm fixed for
   * v1.
   */
  ops: EditOp[];
}

/** The outcome of an `edit` call. */
export interface EditResult {
  success: boolean;
  /** SHA-256 of the file after the edit (always populated). */
  fileHashAfter: string;
  /** Populated only when `success` is `false`. */
  failure?: EditFailure;
}

export type EditFailureReason =
  | 'hash-mismatch'
  | 'file-rev-mismatch'
  | 'ambiguous-reapply'
  | 'patch-syntax'
  | 'path-not-found'
  | 'permission-denied';

/** Structured failure detail. */
export interface EditFailure {
  reason: EditFailureReason;
  /**
   * The live file SHA-256, returned on `file-rev-mismatch` so the
   * agent can re-read at the new revision.
   */
  fileHashActual?: string;
  /** Per-anchor mismatch detail, populated on `hash-mismatch`. */
  mismatches?: AnchorMismatch[];
  /** Free-form diagnostic for `patch-syntax`, `permission-denied`. */
  message?: string;
}

export interface AnchorMismatch {
  line: number;
  hashExpected: string;
  hashActual: string;
}

/** Options to `EndoGuest.edit`. */
export interface EditOptions {
  /**
   * Bounded relocation search per anchor: when an anchor's hash
   * mismatches, search ±N lines for a unique line whose hash matches.
   * Default false (strict mode).
   */
  reapply?: boolean;
  /** Window radius for `--reapply` search; default 20. */
  reapplyWindow?: number;
  /** Compute the splice but do not write. Default false. */
  dryRun?: boolean;
}

/** Internal: the raw splice result before write. */
export interface SpliceResult {
  lines: string[];
}
