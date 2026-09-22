// @ts-check
/* eslint no-bitwise: ["off"] */
/// <reference types="ses"/>

// Hashline edit-patch module per `designs/cli-edit-verb.md`.
//
// This is the shared pure-function module (no powers, no I/O) so the
// agent's view and the daemon's view of a file agree byte-for-byte.
// The daemon's mount composes these functions with the filesystem and
// a mount-internal lock (see `mount.js`); an agent tool-call composes
// the same functions to author a patch.
//
// Module shape (per the design's "Daemon-side API" section and the
// `EditPatch` envelope):
//
//   - `splitLines` / `joinLines`        - byte-preserving line split
//                                         with trailing-newline tracking
//   - `computeLineHash`                 - CRC32 per-line anchor hash
//   - `computeFileHash`                 - SHA-256 whole-file CAS hash
//   - `anchorWidthForLineCount`         - 2 chars <=4096 lines, else 4
//   - `renderAnchored`                  - read-side LINE#HASH attribution
//   - `parseHashlineText`               - textual hashline -> EditPatch
//   - `parseHashlineJson`               - JSON envelope -> EditPatch
//   - `describePatchProblem`            - structured shape diagnostic
//   - `validateEditPatch`               - throwing shape validator
//   - `validateAnchors`                 - per-line CAS check
//   - `resolveAnchors`                  - CAS + optional reapply relocation
//   - `applyPatch`                      - line-plan splice
//
// Bitwise operators are disabled at file scope because the CRC32 and
// SHA-256 implementations are inherently bit-level (matching the
// project convention in `packages/base64/src/encode.js`).
//
// Each export is hardened at declaration per the project's
// hardened-exports convention.

import { makeError, X, q } from '@endo/errors';

/**
 * @import {
 *   Anchor,
 *   EditOp,
 *   EditPatch,
 *   SplitLinesResult,
 *   AnchorMismatch,
 * } from './hashline.types.js';
 */

const textEncoder = new TextEncoder();

/**
 * The UTF-8 byte length of a string (for the file-size cap check).
 *
 * @param {string} content
 * @returns {number}
 */
export const byteLength = content => textEncoder.encode(content).length;
harden(byteLength);

// --- Line splitting -------------------------------------------------

/**
 * Split a file's byte content into `{ lines, trailingNewline }`. The
 * splice preserves `trailingNewline` byte-for-byte. CRLF is preserved
 * on the line content (the `\r` stays); the LF is the separator.
 *
 * @param {string} content
 * @returns {SplitLinesResult}
 */
export const splitLines = content => {
  if (content === '') {
    // The empty file has no lines and is treated as trailing-newline
    // true so an `append`/`prepend` that populates it yields a
    // newline-terminated file (the common editor convention).
    return harden({ lines: [], trailingNewline: true });
  }
  const trailingNewline = content.endsWith('\n');
  const body = trailingNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n');
  return harden({ lines, trailingNewline });
};
harden(splitLines);

/**
 * Inverse of `splitLines`: join lines with LF separators, appending a
 * final LF when `trailingNewline` is true.
 *
 * @param {SplitLinesResult} parts
 * @returns {string}
 */
export const joinLines = parts => {
  const { lines, trailingNewline } = parts;
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n') + (trailingNewline ? '\n' : '');
};
harden(joinLines);

// --- CRC32 (per-line anchor) ----------------------------------------

/** @type {Uint32Array | undefined} */
let crc32Table;

const getCrc32Table = () => {
  if (crc32Table !== undefined) {
    return crc32Table;
  }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crc32Table = table;
  return table;
};

/**
 * CRC32 (IEEE polynomial, as in `zlib.crc32`) of a byte array.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
const crc32Bytes = bytes => {
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Normalize a line for hashing: strip a trailing `\r` (CRLF -> LF) and
 * strip trailing whitespace, but preserve leading whitespace
 * (indentation is significant). Empty / whitespace-only lines are
 * seeded with the line number so multiple blanks do not collide.
 *
 * @param {string} line
 * @param {number} lineNumber 1-indexed
 * @returns {string}
 */
const normalizeLineForHash = (line, lineNumber) => {
  const stripped = line.replace(/\s+$/u, '');
  if (stripped === '') {
    // Seed with the line number so blank lines are distinct anchors.
    return ` ${lineNumber}`;
  }
  return stripped;
};

/**
 * Compute the CRC32 anchor hash of a single line, rendered as `width`
 * lowercase hex chars. `width` is 2 for files <=4096 lines, 4 otherwise
 * (see `anchorWidthForLineCount`).
 *
 * @param {string} line
 * @param {number} lineNumber 1-indexed
 * @param {number} width 2 or 4
 * @returns {string}
 */
export const computeLineHash = (line, lineNumber, width) => {
  const normalized = normalizeLineForHash(line, lineNumber);
  const crc = crc32Bytes(textEncoder.encode(normalized));
  const mask = width <= 2 ? 0xff : 0xffff;
  return (crc & mask).toString(16).padStart(width, '0');
};
harden(computeLineHash);

/**
 * The anchor hex width the daemon renders for a file with `lineCount`
 * lines: 2 chars for <=4096 lines, 4 chars above.
 *
 * @param {number} lineCount
 * @returns {number} 2 or 4
 */
export const anchorWidthForLineCount = lineCount => (lineCount > 4096 ? 4 : 2);
harden(anchorWidthForLineCount);

// --- SHA-256 (whole-file CAS) ---------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Pure SHA-256 of a byte array, rendered as 64-char lowercase hex.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const sha256Hex = bytes => {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const paddedLen = withOne + ((64 - ((withOne + 8) % 64)) % 64) + 8;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += h[i].toString(16).padStart(8, '0');
  }
  return out;
};

/**
 * Compute the SHA-256 of a file's full byte content (UTF-8), rendered
 * as 64-char lowercase hex. This is the whole-file CAS hash. The empty
 * file's canonical hash is
 * `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *
 * @param {string} content
 * @returns {Promise<string>}
 */
export const computeFileHash = async content => {
  await null;
  return sha256Hex(textEncoder.encode(content));
};
harden(computeFileHash);

// --- Read-side attribution ------------------------------------------

/**
 * Render a file's content with hashline attribution: each line prefixed
 * with `LINE#HASH ` (the design's display format). An agent uses the
 * anchors and the separate `computeFileHash` result to author a patch.
 *
 * @param {string} content
 * @returns {string}
 */
export const renderAnchored = content => {
  const { lines } = splitLines(content);
  const width = anchorWidthForLineCount(lines.length);
  const numWidth = String(lines.length).length;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const hash = computeLineHash(lines[i], lineNumber, width);
    const num = String(lineNumber).padStart(numWidth, ' ');
    out.push(`${num}#${hash} ${lines[i]}`);
  }
  return out.join('\n');
};
harden(renderAnchored);

// --- Patch shape validation -----------------------------------------

const OP_KINDS = harden([
  'replace',
  'replace-range',
  'delete',
  'insert-after',
  'insert-before',
  'prepend',
  'append',
]);

const ANCHORED_OPS = harden([
  'replace',
  'replace-range',
  'delete',
  'insert-after',
  'insert-before',
]);

const RANGE_OPS = harden(['replace-range']);
const NO_ANCHOR_OPS = harden(['prepend', 'append']);
const PAYLOAD_OPS = harden([
  'replace',
  'replace-range',
  'insert-after',
  'insert-before',
  'prepend',
  'append',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_ANCHOR = /^[0-9a-f]{1,4}$/;

/**
 * @param {unknown} anchor
 * @param {string} label
 * @returns {string | undefined} diagnostic, or undefined if valid
 */
const anchorProblem = (anchor, label) => {
  if (!isPlainObject(anchor)) {
    return `${label} must be an object with { line, hash }`;
  }
  const { line, hash } = anchor;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return `${label}.line must be a positive integer, got ${q(line)}`;
  }
  if (typeof hash !== 'string' || !HEX_ANCHOR.test(hash)) {
    return `${label}.hash must be 1-4 lowercase hex chars, got ${q(hash)}`;
  }
  return undefined;
};

/**
 * Inspect an `EditPatch`-shaped value and return a human diagnostic if
 * it is malformed, or `undefined` if it is a well-formed patch. This is
 * the non-throwing form the daemon uses to produce a structured
 * `patch-syntax` failure.
 *
 * @param {unknown} patch
 * @returns {string | undefined}
 */
export const describePatchProblem = patch => {
  if (!isPlainObject(patch)) {
    return 'patch must be an object';
  }
  const { expectedFileHash, ops } = patch;
  if (typeof expectedFileHash !== 'string' || !HEX_64.test(expectedFileHash)) {
    return 'expectedFileHash must be 64 lowercase hex chars (SHA-256)';
  }
  if (!Array.isArray(ops)) {
    return 'ops must be an array';
  }
  // Track lines consumed by replace/delete for the duplicate-anchor rule.
  const consumed = new Set();
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const at = `ops[${i}]`;
    if (!isPlainObject(op)) {
      return `${at} must be an object`;
    }
    const { op: kind, anchor, anchorEnd, payload } = op;
    if (typeof kind !== 'string' || !OP_KINDS.includes(kind)) {
      return `${at}.op must be one of ${q(OP_KINDS)}, got ${q(kind)}`;
    }
    if (ANCHORED_OPS.includes(kind)) {
      const problem = anchorProblem(anchor, `${at}.anchor`);
      if (problem) return problem;
    } else if (anchor !== undefined) {
      return `${at}.anchor is not allowed for op ${q(kind)}`;
    }
    const hasRange = RANGE_OPS.includes(kind) || (kind === 'delete' && anchorEnd);
    if (hasRange) {
      const problem = anchorProblem(anchorEnd, `${at}.anchorEnd`);
      if (problem) return problem;
      const a = /** @type {Anchor} */ (anchor);
      const b = /** @type {Anchor} */ (anchorEnd);
      if (b.line < a.line) {
        return `${at}.anchorEnd.line must be >= anchor.line`;
      }
    } else if (anchorEnd !== undefined) {
      return `${at}.anchorEnd is not allowed for op ${q(kind)}`;
    }
    if (payload !== undefined) {
      if (
        !Array.isArray(payload) ||
        payload.some(l => typeof l !== 'string')
      ) {
        return `${at}.payload must be an array of strings`;
      }
      if (payload.some(l => l.includes('\n'))) {
        return `${at}.payload entries must not contain an embedded newline`;
      }
      if (!PAYLOAD_OPS.includes(kind)) {
        return `${at}.payload is not allowed for op ${q(kind)}`;
      }
    }
    // Duplicate-consume detection for replace / delete / range.
    if (kind === 'replace' || kind === 'delete' || kind === 'replace-range') {
      const a = /** @type {Anchor} */ (anchor);
      const start = a.line;
      const end =
        kind === 'replace-range' || anchorEnd
          ? /** @type {Anchor} */ (anchorEnd).line
          : a.line;
      for (let ln = start; ln <= end; ln += 1) {
        if (consumed.has(ln)) {
          return `line ${ln} is consumed by more than one replace/delete op`;
        }
        consumed.add(ln);
      }
    }
  }
  return undefined;
};
harden(describePatchProblem);

/**
 * Validate the shape of an `EditPatch` envelope, throwing on malformed
 * input and returning the value on success. The daemon prefers
 * `describePatchProblem` (non-throwing) so it can return a structured
 * `patch-syntax` failure; this throwing form serves programmatic
 * callers that want an assertion.
 *
 * @param {unknown} patch
 * @returns {EditPatch}
 */
export const validateEditPatch = patch => {
  const problem = describePatchProblem(patch);
  if (problem !== undefined) {
    throw makeError(X`hashline patch-syntax: ${q(problem)}`);
  }
  return /** @type {EditPatch} */ (patch);
};
harden(validateEditPatch);

// --- Textual + JSON parsers -----------------------------------------

/**
 * Parse an `LINE#HASH` anchor token.
 *
 * @param {string} token
 * @returns {Anchor}
 */
const parseAnchorToken = token => {
  const match = /^([0-9]+)#([0-9a-f]{1,4})$/.exec(token);
  if (match === null) {
    throw makeError(X`hashline patch-syntax: bad anchor token ${q(token)}`);
  }
  return harden({ line: Number(match[1]), hash: match[2] });
};

/**
 * Parse the textual hashline patch format into an `EditPatch` envelope.
 * See the design's "Format: hashline (textual)" section.
 *
 * @param {string} text
 * @returns {EditPatch}
 */
export const parseHashlineText = text => {
  const rawLines = text.split('\n');
  /** @type {string | undefined} */
  let expectedFileHash;
  /** @type {any[]} */
  const ops = [];
  /** @type {any} */
  let current;

  const flush = () => {
    if (current) {
      ops.push(harden(current));
      current = undefined;
    }
  };

  const startOp = argLine => {
    flush();
    const rest = argLine.slice(1).trim();
    const spaceIdx = rest.indexOf(' ');
    const kind = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const argStr = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
    if (NO_ANCHOR_OPS.includes(kind)) {
      current = { op: kind, payload: [] };
    } else if (!ANCHORED_OPS.includes(kind)) {
      throw makeError(X`hashline patch-syntax: unknown op ${q(kind)}`);
    } else if (argStr.includes('..')) {
      const [a, b] = argStr.split('..');
      const opKind = kind === 'delete' ? 'delete' : 'replace-range';
      current = {
        op: opKind,
        anchor: parseAnchorToken(a.trim()),
        anchorEnd: parseAnchorToken(b.trim()),
        payload: [],
      };
    } else {
      current = { op: kind, anchor: parseAnchorToken(argStr), payload: [] };
    }
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (line.startsWith('| ')) {
      if (!current) {
        throw makeError(
          X`hashline patch-syntax: payload line ${q(i + 1)} has no operation`,
        );
      }
      current.payload.push(line.slice(2));
    } else if (line === '|') {
      if (!current) {
        throw makeError(
          X`hashline patch-syntax: payload line ${q(i + 1)} has no operation`,
        );
      }
      current.payload.push('');
    } else if (line.trim() === '') {
      flush();
    } else if (line.startsWith('@expected-file-hash ')) {
      flush();
      expectedFileHash = line.slice('@expected-file-hash '.length).trim();
    } else if (line.startsWith('#')) {
      // Comment line: ignored.
      flush();
    } else if (line.startsWith('@')) {
      startOp(line);
    } else {
      throw makeError(
        X`hashline patch-syntax: unexpected line ${q(i + 1)}: ${q(line)}`,
      );
    }
  }
  flush();

  if (expectedFileHash === undefined) {
    throw makeError(X`hashline patch-syntax: missing @expected-file-hash header`);
  }
  return validateEditPatch(harden({ expectedFileHash, ops }));
};
harden(parseHashlineText);

/**
 * Parse the structured `hashline-json` envelope. Accepts either a JSON
 * string or a plain object; narrows it to a validated `EditPatch`.
 *
 * @param {unknown} value
 * @returns {EditPatch}
 */
export const parseHashlineJson = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return validateEditPatch(parsed);
};
harden(parseHashlineJson);

// --- Anchor validation + reapply relocation -------------------------

/**
 * The declared hex width of an anchor is the length of its hash string;
 * the validator recomputes the live line's CRC at that width.
 *
 * @param {string} hash
 * @returns {number}
 */
const anchorWidthAt = hash => hash.length;

/**
 * Validate every per-line anchor in the patch against the live file's
 * lines at each anchor's declared width. Returns an empty array on full
 * match; returns a list of `AnchorMismatch` records otherwise.
 *
 * @param {EditPatch} patch
 * @param {SplitLinesResult} parts
 * @returns {AnchorMismatch[]}
 */
export const validateAnchors = (patch, parts) => {
  const { lines } = parts;
  const fileWidth = anchorWidthForLineCount(lines.length);
  /** @type {AnchorMismatch[]} */
  const mismatches = [];
  /** @param {Anchor} anchor */
  const check = anchor => {
    const { line, hash } = anchor;
    const width = anchorWidthAt(hash);
    if (line < 1 || line > lines.length) {
      mismatches.push(
        harden({
          line,
          hashExpected: hash,
          hashActualAtPatchWidth: '',
          hashActualAtFileWidth: '',
        }),
      );
      return;
    }
    const actualAtPatch = computeLineHash(lines[line - 1], line, width);
    if (actualAtPatch !== hash) {
      mismatches.push(
        harden({
          line,
          hashExpected: hash,
          hashActualAtPatchWidth: actualAtPatch,
          hashActualAtFileWidth: computeLineHash(
            lines[line - 1],
            line,
            fileWidth,
          ),
        }),
      );
    }
  };
  for (const op of patch.ops) {
    if (op.anchor) check(op.anchor);
    if (op.anchorEnd) check(op.anchorEnd);
  }
  return harden(mismatches);
};
harden(validateAnchors);

/**
 * Search a bounded window around an anchor for lines whose hash matches
 * (at the anchor's declared width). Visits lines in nearest-by-line-
 * distance order; ties break lower-line-number-first.
 *
 * @param {SplitLinesResult} parts
 * @param {Anchor} anchor
 * @param {number} window
 * @returns {number[]} candidate line numbers
 */
const relocateCandidates = (parts, anchor, window) => {
  const { lines } = parts;
  const { line, hash } = anchor;
  const width = anchorWidthAt(hash);
  /** @type {number[]} */
  const candidates = [];
  /** @param {number} ln */
  const consider = ln => {
    if (ln < 1 || ln > lines.length) return;
    if (computeLineHash(lines[ln - 1], ln, width) === hash) {
      candidates.push(ln);
    }
  };
  consider(line);
  for (let d = 1; d <= window; d += 1) {
    consider(line - d);
    consider(line + d);
  }
  return candidates;
};

/**
 * Resolve every anchor in the patch against the live file. In strict
 * mode (default) an anchor whose hash mismatches its line is a
 * `hash-mismatch` failure. In reapply mode a mismatching anchor is
 * relocated to the single matching line within the window; zero matches
 * is `hash-mismatch`, multiple is `ambiguous-reapply`.
 *
 * On success returns `{ status: 'ok', patch }` with anchors rewritten
 * to their resolved line numbers so `applyPatch` can splice directly.
 *
 * @param {EditPatch} patch
 * @param {SplitLinesResult} parts
 * @param {{ reapply?: boolean, reapplyWindow?: number }} [options]
 * @returns {{ status: 'ok', patch: EditPatch }
 *   | { status: 'hash-mismatch', mismatches: AnchorMismatch[] }
 *   | { status: 'ambiguous-reapply', candidates: number[] }}
 */
export const resolveAnchors = (patch, parts, options = {}) => {
  const { reapply = false, reapplyWindow = DEFAULT_REAPPLY_WINDOW } = options;
  if (!reapply) {
    const mismatches = validateAnchors(patch, parts);
    if (mismatches.length > 0) {
      return harden({ status: 'hash-mismatch', mismatches });
    }
    return harden({ status: 'ok', patch });
  }

  const window = Math.min(Math.max(1, reapplyWindow), MAX_REAPPLY_WINDOW);
  const { lines } = parts;
  const fileWidth = anchorWidthForLineCount(lines.length);
  /** @type {AnchorMismatch[]} */
  const mismatches = [];
  /** @type {number[] | undefined} */
  let ambiguous;

  /**
   * @param {Anchor} anchor
   * @returns {Anchor}
   */
  const resolveOne = anchor => {
    const width = anchorWidthAt(anchor.hash);
    const matchesHere =
      anchor.line >= 1 &&
      anchor.line <= lines.length &&
      computeLineHash(lines[anchor.line - 1], anchor.line, width) ===
        anchor.hash;
    if (matchesHere) {
      return anchor;
    }
    const candidates = relocateCandidates(parts, anchor, window);
    if (candidates.length === 1) {
      return harden({ ...anchor, line: candidates[0] });
    }
    if (candidates.length > 1) {
      ambiguous = candidates;
      return anchor;
    }
    const within = anchor.line >= 1 && anchor.line <= lines.length;
    mismatches.push(
      harden({
        line: anchor.line,
        hashExpected: anchor.hash,
        hashActualAtPatchWidth: within
          ? computeLineHash(lines[anchor.line - 1], anchor.line, width)
          : '',
        hashActualAtFileWidth: within
          ? computeLineHash(lines[anchor.line - 1], anchor.line, fileWidth)
          : '',
      }),
    );
    return anchor;
  };

  /** @type {EditOp[]} */
  const resolvedOps = [];
  for (const op of patch.ops) {
    /** @type {EditOp} */
    const next = { op: op.op };
    if (op.payload) next.payload = op.payload;
    if (op.anchor) next.anchor = resolveOne(op.anchor);
    if (op.anchorEnd) next.anchorEnd = resolveOne(op.anchorEnd);
    resolvedOps.push(harden(next));
  }
  if (ambiguous !== undefined) {
    return harden({ status: 'ambiguous-reapply', candidates: ambiguous });
  }
  if (mismatches.length > 0) {
    return harden({ status: 'hash-mismatch', mismatches: harden(mismatches) });
  }
  return harden({
    status: 'ok',
    patch: harden({
      expectedFileHash: patch.expectedFileHash,
      ops: resolvedOps,
    }),
  });
};
harden(resolveAnchors);

// --- Splice ---------------------------------------------------------

/**
 * Apply the patch's operations as a line-plan splice. Anchors must
 * already be validated / resolved (see `resolveAnchors`); this function
 * assumes each anchor's `line` points at the intended live line.
 *
 * The plan attaches, per original line, its before-inserts, an optional
 * replacement (or deletion), and its after-inserts, then rebuilds the
 * file top-to-bottom. This yields the same result as a bottom-up splice
 * without index bookkeeping, and gives deterministic behavior when
 * several ops share a line (the design's priority order: `insert-after`
 * emits after the line, `insert-before` before it, in patch order).
 *
 * @param {EditPatch} patch
 * @param {SplitLinesResult} parts
 * @returns {SplitLinesResult}
 */
export const applyPatch = (patch, parts) => {
  const { lines, trailingNewline } = parts;
  const n = lines.length;

  /** @type {string[][]} */
  const before = Array.from({ length: n }, () => []);
  /** @type {string[][]} */
  const after = Array.from({ length: n }, () => []);
  /** @type {(string[] | undefined)[]} */
  const replacement = new Array(n).fill(undefined);
  /** @type {boolean[]} */
  const deleted = new Array(n).fill(false);
  /** @type {string[]} */
  const prepend = [];
  /** @type {string[]} */
  const append = [];

  for (const op of patch.ops) {
    const payload = op.payload || [];
    const anchorLine = op.anchor ? op.anchor.line : 0;
    const endLine = op.anchorEnd ? op.anchorEnd.line : anchorLine;
    switch (op.op) {
      case 'prepend':
        prepend.push(...payload);
        break;
      case 'append':
        append.push(...payload);
        break;
      case 'insert-before':
        before[anchorLine - 1].push(...payload);
        break;
      case 'insert-after':
        after[anchorLine - 1].push(...payload);
        break;
      case 'replace':
        replacement[anchorLine - 1] = payload;
        break;
      case 'delete':
        for (let ln = anchorLine; ln <= endLine; ln += 1) {
          deleted[ln - 1] = true;
        }
        break;
      case 'replace-range':
        for (let ln = anchorLine; ln <= endLine; ln += 1) {
          deleted[ln - 1] = true;
        }
        // Emit the replacement at the range start position.
        replacement[anchorLine - 1] = payload;
        deleted[anchorLine - 1] = false;
        break;
      default:
        throw makeError(X`hashline: unknown op ${q(op.op)}`);
    }
  }

  /** @type {string[]} */
  const out = [];
  out.push(...prepend);
  for (let i = 0; i < n; i += 1) {
    out.push(...before[i]);
    const repl = replacement[i];
    if (repl !== undefined) {
      out.push(...repl);
    } else if (!deleted[i]) {
      out.push(lines[i]);
    }
    out.push(...after[i]);
  }
  out.push(...append);

  return harden({ lines: out, trailingNewline });
};
harden(applyPatch);

// --- Constants ------------------------------------------------------

/**
 * The default per-edit file-size cap, in bytes. Files larger than this
 * fail with `patch-syntax` (per the design's Open Question #9).
 */
export const DEFAULT_MAX_EDIT_FILE_SIZE = 16 * 1024 * 1024;
harden(DEFAULT_MAX_EDIT_FILE_SIZE);

/**
 * The default `--reapply` search window, in lines.
 */
export const DEFAULT_REAPPLY_WINDOW = 20;
harden(DEFAULT_REAPPLY_WINDOW);

/**
 * Maximum allowed `--reapply` search window.
 */
export const MAX_REAPPLY_WINDOW = 200;
harden(MAX_REAPPLY_WINDOW);
