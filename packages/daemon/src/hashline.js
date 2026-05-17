// @ts-check
/// <reference types="ses"/>

// Phase 1 skeleton for the hashline edit-patch module per
// `designs/cli-edit-verb.md`. The types in `hashline.types.d.ts` are
// load-bearing; the runtime implementations below are stubs that
// reject with `not_implemented` until Phase 2 lands the daemon-side
// splice.
//
// Module shape (per the design's "Daemon-side API" section and the
// `EditPatch` envelope):
//
//   - `splitLines` / `joinLines`        - byte-preserving line split
//                                         with trailing-newline tracking
//   - `computeLineHash`                 - CRC32 per-line anchor hash
//   - `computeFileHash`                 - SHA-256 whole-file CAS hash
//   - `parseHashlineText`               - textual hashline -> EditPatch
//   - `parseHashlineJson`               - JSON envelope -> EditPatch
//   - `validateEditPatch`               - shape / typing validator
//   - `validateAnchors`                 - per-line CAS check
//   - `applyPatch`                      - bottom-up splice
//
// Each export is hardened at declaration per the project's
// hardened-exports convention.

import { makeError, X } from '@endo/errors';

/**
 * @import {
 *   Anchor,
 *   EditOp,
 *   EditOptions,
 *   EditPatch,
 *   EditResult,
 *   SplitLinesResult,
 *   AnchorMismatch,
 * } from './hashline.types.js';
 */

const notImplemented = name => {
  throw makeError(
    X`hashline.${name}: not implemented (Phase 2 of designs/cli-edit-verb.md)`,
  );
};

/**
 * Split a file's byte content into `{ lines, trailingNewline }`. The
 * splice preserves `trailingNewline` byte-for-byte. CRLF is preserved
 * on the line content (the `\r` stays); the LF is the separator.
 *
 * @param {string} _content
 * @returns {SplitLinesResult}
 */
export const splitLines = _content => {
  return notImplemented('splitLines');
};
harden(splitLines);

/**
 * Inverse of `splitLines`: join lines with LF separators, appending a
 * final LF when `trailingNewline` is true.
 *
 * @param {SplitLinesResult} _parts
 * @returns {string}
 */
export const joinLines = _parts => {
  return notImplemented('joinLines');
};
harden(joinLines);

/**
 * Compute the CRC32 anchor hash of a single line. The line is
 * normalized first: trailing whitespace stripped, CRLF normalized to
 * LF, leading whitespace preserved. Empty / whitespace-only lines are
 * seeded with the line number so multiple blanks do not collide.
 *
 * The returned hex string is lowercase. `width` is 2 for files
 * ≤4096 lines, 4 otherwise; the caller computes the file's native
 * width and passes it here.
 *
 * @param {string} _line
 * @param {number} _lineNumber 1-indexed
 * @param {number} _width 2 or 4
 * @returns {string}
 */
export const computeLineHash = (_line, _lineNumber, _width) => {
  return notImplemented('computeLineHash');
};
harden(computeLineHash);

/**
 * Compute the SHA-256 of a file's full byte content, rendered as
 * 64-char lowercase hex. This is the whole-file CAS hash. The empty
 * file's canonical hash is
 * `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *
 * @param {string} _content
 * @returns {Promise<string>}
 */
export const computeFileHash = async _content => {
  return notImplemented('computeFileHash');
};
harden(computeFileHash);

/**
 * Parse the textual hashline patch format into an `EditPatch`
 * envelope. The textual format is described in the design's
 * "Format: hashline (textual)" section.
 *
 * @param {string} _text
 * @returns {EditPatch}
 */
export const parseHashlineText = _text => {
  return notImplemented('parseHashlineText');
};
harden(parseHashlineText);

/**
 * Parse the structured `hashline-json` envelope. The shape is
 * `EditPatch` directly; this validator narrows from a plain JSON
 * object to the typed envelope.
 *
 * @param {unknown} _value
 * @returns {EditPatch}
 */
export const parseHashlineJson = _value => {
  return notImplemented('parseHashlineJson');
};
harden(parseHashlineJson);

/**
 * Validate the shape of an `EditPatch` envelope. Re-run on entry to
 * the daemon's edit method because CapTP delivers plain JSON and
 * callers cannot rely on hardened envelopes round-tripping.
 *
 * @param {unknown} _patch
 * @returns {EditPatch}
 */
export const validateEditPatch = _patch => {
  return notImplemented('validateEditPatch');
};
harden(validateEditPatch);

/**
 * Validate every per-line anchor in the patch against the live file's
 * lines at the patch's declared anchor width. Returns an empty array
 * on full match; returns a list of `AnchorMismatch` records otherwise.
 *
 * @param {EditPatch} _patch
 * @param {SplitLinesResult} _parts
 * @returns {AnchorMismatch[]}
 */
export const validateAnchors = (_patch, _parts) => {
  return notImplemented('validateAnchors');
};
harden(validateAnchors);

/**
 * Apply the patch's operations as a bottom-up splice. Operations are
 * sorted by line number descending; within a line, the priority order
 * is `insert-after` > `insert-before` > `replace` / `delete`. All
 * anchors must already be validated before this function is called.
 *
 * @param {EditPatch} _patch
 * @param {SplitLinesResult} _parts
 * @returns {SplitLinesResult}
 */
export const applyPatch = (_patch, _parts) => {
  return notImplemented('applyPatch');
};
harden(applyPatch);

/**
 * The default per-edit file-size cap, in bytes. Files larger than this
 * fail with `patch-syntax` (per the design's Open Question #9 best-
 * guess proposal). A future option lets a mount override this default.
 */
export const DEFAULT_MAX_EDIT_FILE_SIZE = 16 * 1024 * 1024;
harden(DEFAULT_MAX_EDIT_FILE_SIZE);

/**
 * The default `--reapply` search window, in lines. Configurable per
 * call via `EditOptions.reapplyWindow`.
 */
export const DEFAULT_REAPPLY_WINDOW = 20;
harden(DEFAULT_REAPPLY_WINDOW);

/**
 * Maximum allowed `--reapply` search window. Larger windows are
 * rejected so a runaway option does not turn a single edit into a
 * many-thousand-hash scan.
 */
export const MAX_REAPPLY_WINDOW = 200;
harden(MAX_REAPPLY_WINDOW);
