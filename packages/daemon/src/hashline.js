// @ts-check
/// <reference types="ses"/>
/* eslint-disable no-bitwise -- CRC32 and SHA-256 are bit-twiddling
   algorithms; the whole module computes per-line and whole-file hashes. */

// Phase 2 implementation of the hashline edit-patch module per
// `designs/cli-edit-verb.md`. The types in `hashline.types.d.ts` are
// the wire contract; the pure functions below are the shared,
// byte-for-byte splice/validator logic the daemon-side `EndoMount.edit`
// critical section composes (and that a CLI-side `hashline.js` would
// re-export so the agent's view and the daemon's view agree).
//
// The module is deliberately dependency-free (CRC32 and SHA-256 are
// implemented in-module) so it is portable across the Node and XS
// daemon supervisors and so the agent-side and daemon-side renderings
// of a line's anchor are computed by identical code.
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

// A patch-syntax error. Thrown by the parser/validator when an envelope
// is malformed. The daemon's edit method catches any throw from the
// validator/parser and maps it to the structured `patch-syntax` failure
// so a malformed envelope never escapes as a thrown error across the
// eventual-send boundary.
const syntaxError = message => makeError(X`hashline: ${message}`);

/**
 * The set of operation discriminators accepted in an `EditPatch`.
 */
const OP_KINDS = new Set([
  'replace',
  'replace-range',
  'delete',
  'insert-after',
  'insert-before',
  'prepend',
  'append',
]);

/** Ops that carry a single leading anchor. */
const ANCHORED_OPS = new Set([
  'replace',
  'replace-range',
  'delete',
  'insert-after',
  'insert-before',
]);

/** Ops that carry a trailing (range-end) anchor. */
const RANGE_OPS = new Set(['replace-range']);

/** Ops that carry inserted / replacement payload lines. */
const PAYLOAD_OPS = new Set([
  'replace',
  'replace-range',
  'insert-after',
  'insert-before',
  'prepend',
  'append',
]);

/**
 * Files at or below this many lines render 2-char (8-bit) anchors;
 * larger files render 4-char (16-bit) anchors. A patch authored against
 * a small rendering stays valid after the file grows because each
 * anchor carries its own width and the validator recomputes at the
 * patch's declared width.
 */
export const LARGE_FILE_LINE_THRESHOLD = 4096;
harden(LARGE_FILE_LINE_THRESHOLD);

/**
 * The native anchor hex width for a file with `lineCount` lines.
 *
 * @param {number} lineCount
 * @returns {2 | 4}
 */
export const hashWidthForLineCount = lineCount =>
  lineCount > LARGE_FILE_LINE_THRESHOLD ? 4 : 2;
harden(hashWidthForLineCount);

/**
 * Encode a JS string as an array of UTF-8 byte values. Implemented
 * in-module (no `TextEncoder`) so the hashing agrees byte-for-byte on
 * both the Node and XS daemon supervisors, including multi-byte
 * (surrogate-pair) code points.
 *
 * @param {string} str
 * @returns {number[]}
 */
const utf8Bytes = str => {
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
};

/**
 * Count the UTF-8 byte length of a string without materializing the
 * byte array (used for the file-size cap pre-check so a giant file is
 * rejected before the splice reads it into a byte buffer).
 *
 * @param {string} str
 * @returns {number}
 */
export const utf8ByteLength = str => {
  let total = 0;
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code < 0x10000) total += 3;
    else total += 4;
  }
  return total;
};
harden(utf8ByteLength);

// --- CRC32 (IEEE polynomial, as in zlib.crc32) ---

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 of a JS string's UTF-8 bytes, as an unsigned 32-bit integer.
 *
 * @param {string} str
 * @returns {number}
 */
const crc32 = str => {
  const bytes = utf8Bytes(str);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// --- SHA-256 (pure, for the whole-file CAS hash) ---

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
 * SHA-256 of a string's UTF-8 bytes, as 64-char lowercase hex.
 *
 * @param {string} message
 * @returns {string}
 */
const sha256Hex = message => {
  const bytes = utf8Bytes(message);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  // 64-bit big-endian length; the high 32 bits fit our sizes at zero
  // for any file under 2^32 bits, but compute both words correctly.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] =
        ((bytes[j] << 24) |
          (bytes[j + 1] << 16) |
          (bytes[j + 2] << 8) |
          bytes[j + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
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

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += h[i].toString(16).padStart(8, '0');
  }
  return hex;
};

/**
 * Split a file's byte content into `{ lines, trailingNewline }`. The
 * splice preserves `trailingNewline` byte-for-byte. CRLF is preserved
 * on the line content (the `\r` stays); the LF is the separator. The
 * empty file yields `{ lines: [], trailingNewline: true }`.
 *
 * @param {string} content
 * @returns {SplitLinesResult}
 */
export const splitLines = content => {
  if (content === '') {
    return harden({ lines: [], trailingNewline: true });
  }
  const trailingNewline = content.endsWith('\n');
  const body = trailingNewline ? content.slice(0, -1) : content;
  return harden({ lines: harden(body.split('\n')), trailingNewline });
};
harden(splitLines);

/**
 * Inverse of `splitLines`: join lines with LF separators, appending a
 * final LF when `trailingNewline` is true. An empty `lines` array
 * renders the empty file regardless of `trailingNewline`.
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

/**
 * Normalize a line for anchor hashing: strip the trailing CR (CRLF ->
 * LF for the hash input only), strip trailing whitespace, preserve
 * leading whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
const normalizeForHash = line => line.replace(/\r$/, '').replace(/\s+$/, '');

/**
 * Compute the CRC32 anchor hash of a single line. The line is
 * normalized first: trailing whitespace stripped, CRLF normalized to
 * LF, leading whitespace preserved. Empty / whitespace-only lines are
 * seeded with the line number so multiple blanks do not collide.
 *
 * The returned hex string is lowercase. `width` is 2 for files
 * ≤4096 lines, 4 otherwise; the caller computes the file's native
 * width (or the patch's declared width) and passes it here.
 *
 * @param {string} line
 * @param {number} lineNumber 1-indexed
 * @param {number} width 2 or 4
 * @returns {string}
 */
export const computeLineHash = (line, lineNumber, width) => {
  const normalized = normalizeForHash(line);
  // Seed blank / whitespace-only lines with the line number so multiple
  // blank lines do not all collapse onto the same anchor.
  const crc =
    normalized === '' ? crc32(` blank:${lineNumber}`) : crc32(normalized);
  const mask = width <= 2 ? 0xff : 0xffff;
  return (crc & mask).toString(16).padStart(width, '0');
};
harden(computeLineHash);

/**
 * Compute the SHA-256 of a file's full byte content, rendered as
 * 64-char lowercase hex. This is the whole-file CAS hash. The empty
 * file's canonical hash is
 * `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *
 * @param {string} content
 * @returns {Promise<string>}
 */
export const computeFileHash = async content => {
  return sha256Hex(content);
};
harden(computeFileHash);

const HEX64_RE = /^[0-9a-f]{64}$/;
const ANCHOR_HASH_RE = /^[0-9a-f]{2,4}$/;

/**
 * Validate one anchor's shape.
 *
 * @param {unknown} anchor
 * @param {string} where diagnostic context
 * @returns {Anchor}
 */
const validateAnchor = (anchor, where) => {
  if (typeof anchor !== 'object' || anchor === null) {
    throw syntaxError(`${where}: anchor must be an object`);
  }
  const { line, hash } = /** @type {any} */ (anchor);
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw syntaxError(`${where}: anchor line must be a positive integer`);
  }
  if (typeof hash !== 'string' || !ANCHOR_HASH_RE.test(hash)) {
    throw syntaxError(`${where}: anchor hash must be 2-4 lowercase hex chars`);
  }
  return harden({ line, hash });
};

/**
 * Validate the shape of an `EditPatch` envelope. Re-run on entry to
 * the daemon's edit method because CapTP delivers plain JSON and
 * callers cannot rely on hardened envelopes round-tripping. Throws a
 * `PatchSyntaxError` on any malformed field; the daemon maps a throw
 * here to the structured `patch-syntax` failure.
 *
 * @param {unknown} patch
 * @returns {EditPatch}
 */
export const validateEditPatch = patch => {
  if (typeof patch !== 'object' || patch === null) {
    throw syntaxError('patch must be an object');
  }
  const { expectedFileHash, ops } = /** @type {any} */ (patch);
  if (
    typeof expectedFileHash !== 'string' ||
    !HEX64_RE.test(expectedFileHash)
  ) {
    throw syntaxError('expectedFileHash must be 64-char lowercase hex');
  }
  if (!Array.isArray(ops)) {
    throw syntaxError('ops must be an array');
  }

  /** @type {EditOp[]} */
  const validatedOps = [];
  // Track the starting line of each replace / replace-range so a second
  // replace anchored on the same line is rejected (its payload would
  // shadow the second's anchor; see the design's anchor-uniqueness rule).
  const replaceLines = new Set();

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    const where = `ops[${index}]`;
    if (typeof op !== 'object' || op === null) {
      throw syntaxError(`${where} must be an object`);
    }
    const { op: kind, anchor, anchorEnd, payload } = /** @type {any} */ (op);
    if (typeof kind !== 'string' || !OP_KINDS.has(kind)) {
      throw syntaxError(`${where}: unknown op ${q(kind)}`);
    }

    /** @type {EditOp} */
    const out = {
      op: /** @type {import('./hashline.types.js').EditOpKind} */ (kind),
    };

    if (ANCHORED_OPS.has(kind)) {
      out.anchor = validateAnchor(anchor, where);
    } else if (anchor !== undefined) {
      throw syntaxError(`${where}: ${kind} does not take an anchor`);
    }

    if (RANGE_OPS.has(kind)) {
      // `replace-range` requires a range-end anchor.
      out.anchorEnd = validateAnchor(anchorEnd, `${where} (range end)`);
    } else if (kind === 'delete' && anchorEnd !== undefined) {
      // `delete` optionally spans an inclusive range (one or two anchors).
      out.anchorEnd = validateAnchor(anchorEnd, `${where} (range end)`);
    } else if (anchorEnd !== undefined) {
      throw syntaxError(`${where}: ${kind} does not take a range-end anchor`);
    }
    if (
      out.anchorEnd !== undefined &&
      out.anchorEnd.line < /** @type {Anchor} */ (out.anchor).line
    ) {
      throw syntaxError(`${where}: range end precedes range start`);
    }

    if (payload !== undefined) {
      if (!Array.isArray(payload)) {
        throw syntaxError(`${where}: payload must be an array of strings`);
      }
      for (const entry of payload) {
        if (typeof entry !== 'string') {
          throw syntaxError(`${where}: payload entries must be strings`);
        }
        if (entry.includes('\n')) {
          throw syntaxError(
            `${where}: payload entry must not contain an embedded newline`,
          );
        }
      }
      out.payload = harden([...payload]);
    } else if (PAYLOAD_OPS.has(kind)) {
      // A payload-bearing op with no payload is a delete-shaped no-op;
      // normalize to an empty payload so the splice is total.
      out.payload = harden([]);
    }

    if (kind === 'replace' || kind === 'replace-range') {
      const startLine = /** @type {Anchor} */ (out.anchor).line;
      if (replaceLines.has(startLine)) {
        throw syntaxError(
          `${where}: duplicate replace anchored on line ${startLine}`,
        );
      }
      replaceLines.add(startLine);
    }

    validatedOps.push(harden(out));
  }

  return harden({ expectedFileHash, ops: harden(validatedOps) });
};
harden(validateEditPatch);

/**
 * Parse the structured `hashline-json` envelope. The shape is
 * `EditPatch` directly; this validator narrows from a plain JSON
 * object to the typed envelope. Accepts either a parsed object or a
 * JSON string.
 *
 * @param {unknown} value
 * @returns {EditPatch}
 */
export const parseHashlineJson = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return validateEditPatch(parsed);
};
harden(parseHashlineJson);

/**
 * Parse a `LINE#HASH` anchor token.
 *
 * @param {string} token
 * @returns {Anchor}
 */
const parseAnchorToken = token => {
  const hashIndex = token.indexOf('#');
  if (hashIndex < 0) {
    throw syntaxError(`anchor ${q(token)} must be LINE#HASH`);
  }
  const line = Number(token.slice(0, hashIndex));
  const hash = token.slice(hashIndex + 1);
  if (!Number.isInteger(line) || line < 1) {
    throw syntaxError(`anchor ${q(token)} has a non-positive-integer line`);
  }
  return harden({ line, hash });
};

/**
 * Parse the textual hashline patch format into an `EditPatch`
 * envelope. The textual format is described in the design's
 * "Format: hashline (textual)" section: an `@expected-file-hash`
 * header, `@op anchor[..anchor]` operation headers, and `| ` payload
 * lines. Comment lines begin with `#`; a blank line ends an operation.
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

  const endOp = () => {
    if (current !== undefined) {
      ops.push(current);
      current = undefined;
    }
  };

  /** @param {string} entry */
  const pushPayload = entry => {
    if (current === undefined) {
      throw syntaxError('payload line has no preceding operation');
    }
    current.payload.push(entry);
  };

  /** @param {string} raw */
  const beginOp = raw => {
    endOp();
    const header = raw.slice(1).trim();
    const spaceIndex = header.indexOf(' ');
    const kind = spaceIndex < 0 ? header : header.slice(0, spaceIndex);
    const rest = spaceIndex < 0 ? '' : header.slice(spaceIndex + 1).trim();
    current = { op: kind, payload: [] };
    if (rest !== '') {
      const rangeIndex = rest.indexOf('..');
      if (rangeIndex >= 0) {
        current.anchor = parseAnchorToken(rest.slice(0, rangeIndex).trim());
        current.anchorEnd = parseAnchorToken(rest.slice(rangeIndex + 2).trim());
        // Textual `replace` with a range becomes `replace-range`.
        if (kind === 'replace') {
          current.op = 'replace-range';
        }
      } else {
        current.anchor = parseAnchorToken(rest);
      }
    }
  };

  for (const raw of rawLines) {
    if (raw.startsWith('| ')) {
      pushPayload(raw.slice(2));
    } else if (raw === '|') {
      pushPayload('');
    } else if (raw.trim() === '') {
      endOp();
    } else if (raw.startsWith('#')) {
      // comment: ignore
    } else if (raw.startsWith('@expected-file-hash ')) {
      endOp();
      expectedFileHash = raw.slice('@expected-file-hash '.length).trim();
    } else if (raw.startsWith('@')) {
      beginOp(raw);
    } else {
      throw syntaxError(`unrecognized patch line: ${q(raw)}`);
    }
  }
  endOp();

  if (expectedFileHash === undefined) {
    throw syntaxError('missing @expected-file-hash header');
  }

  // A `delete` carries no payload; drop the accumulator's empty array so
  // the validator does not attach a spurious empty payload to it.
  for (const op of ops) {
    if (op.op === 'delete') {
      delete op.payload;
    }
  }

  return validateEditPatch({ expectedFileHash, ops });
};
harden(parseHashlineText);

/**
 * Validate every per-line anchor in the patch against the live file's
 * lines at the patch's declared anchor width. Returns an empty array
 * on full match; returns a list of `AnchorMismatch` records otherwise.
 *
 * @param {EditPatch} patch
 * @param {SplitLinesResult} parts
 * @returns {AnchorMismatch[]}
 */
export const validateAnchors = (patch, parts) => {
  const { lines } = parts;
  const fileWidth = hashWidthForLineCount(lines.length);
  /** @type {AnchorMismatch[]} */
  const mismatches = [];

  /** @param {Anchor} anchor */
  const checkAnchor = anchor => {
    const { line, hash } = anchor;
    const patchWidth = hash.length;
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
    const content = lines[line - 1];
    const actualAtPatchWidth = computeLineHash(content, line, patchWidth);
    if (actualAtPatchWidth !== hash) {
      mismatches.push(
        harden({
          line,
          hashExpected: hash,
          hashActualAtPatchWidth: actualAtPatchWidth,
          hashActualAtFileWidth: computeLineHash(content, line, fileWidth),
        }),
      );
    }
  };

  for (const op of patch.ops) {
    if (op.anchor !== undefined) {
      checkAnchor(op.anchor);
    }
    if (op.anchorEnd !== undefined) {
      checkAnchor(op.anchorEnd);
    }
  }

  return harden(mismatches);
};
harden(validateAnchors);

/**
 * The sort priority of an op at a shared line: `insert-after` (0)
 * applies before `insert-before` (1) before `replace` / `delete` (2),
 * per the design's anchor-uniqueness tiebreaker.
 *
 * @param {string} kind
 * @returns {number}
 */
const opPriority = kind => {
  if (kind === 'insert-after') return 0;
  if (kind === 'insert-before') return 1;
  return 2;
};

/**
 * The 1-indexed line an op sorts on for the bottom-up splice.
 *
 * @param {EditOp} op
 * @param {number} lineCount
 * @returns {number}
 */
const sortLineOf = (op, lineCount) => {
  if (op.op === 'prepend') return 0;
  if (op.op === 'append') return lineCount + 1;
  return /** @type {Anchor} */ (op.anchor).line;
};

/**
 * Apply the patch's operations as a bottom-up splice. Operations are
 * sorted by line number descending; within a line, the priority order
 * is `insert-after` > `insert-before` > `replace` / `delete`, then
 * patch order. All anchors must already be validated (via
 * `validateAnchors`) before this function is called.
 *
 * @param {EditPatch} patch
 * @param {SplitLinesResult} parts
 * @returns {SplitLinesResult}
 */
export const applyPatch = (patch, parts) => {
  const lines = [...parts.lines];
  const lineCount = parts.lines.length;

  const ordered = patch.ops.map((op, index) => ({ op, index }));
  ordered.sort((a, b) => {
    const lineDelta = sortLineOf(b.op, lineCount) - sortLineOf(a.op, lineCount);
    if (lineDelta !== 0) return lineDelta;
    const priorityDelta = opPriority(a.op.op) - opPriority(b.op.op);
    if (priorityDelta !== 0) return priorityDelta;
    return a.index - b.index;
  });

  for (const { op } of ordered) {
    const payload = op.payload ? [...op.payload] : [];
    switch (op.op) {
      case 'prepend':
        lines.splice(0, 0, ...payload);
        break;
      case 'append':
        lines.splice(lines.length, 0, ...payload);
        break;
      case 'insert-before':
        lines.splice(/** @type {Anchor} */ (op.anchor).line - 1, 0, ...payload);
        break;
      case 'insert-after':
        lines.splice(/** @type {Anchor} */ (op.anchor).line, 0, ...payload);
        break;
      case 'replace':
        lines.splice(/** @type {Anchor} */ (op.anchor).line - 1, 1, ...payload);
        break;
      case 'replace-range': {
        const start = /** @type {Anchor} */ (op.anchor).line;
        const end = /** @type {Anchor} */ (op.anchorEnd).line;
        lines.splice(start - 1, end - start + 1, ...payload);
        break;
      }
      case 'delete': {
        const start = /** @type {Anchor} */ (op.anchor).line;
        const end = op.anchorEnd ? op.anchorEnd.line : start;
        lines.splice(start - 1, end - start + 1);
        break;
      }
      default:
        throw syntaxError(`unknown op ${q(op.op)}`);
    }
  }

  return harden({
    lines: harden(lines),
    trailingNewline: parts.trailingNewline,
  });
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
