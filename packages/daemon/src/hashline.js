// @ts-check
/* eslint-disable no-bitwise, no-continue -- CRC32 polynomial math
   (no-bitwise) and tokenizer state machine (no-continue) are the
   load-bearing patterns of this module. */

/**
 * Hashline parser, validator, and pure splice for the `EndoGuest.edit`
 * capability.
 *
 * Per design `cli-edit-verb.md`:
 * - Per-line anchor hash is CRC32 (IEEE polynomial), 2-char hex
 *   (or 4-char for files >4096 lines).
 * - Whole-file CAS hash is SHA-256, lowercase 64-char hex.
 * - Line normalization for CRC32: strip trailing whitespace, normalize
 *   CRLF to LF, preserve leading whitespace.
 * - Empty/whitespace-only lines: seed with line number so multiple
 *   blank lines do not collide.
 *
 * This module is pure and side-effect-free. Callers supply a SHA-256
 * function (Node's `crypto` on the daemon side; the daemon does not
 * need to ship a portable SHA-256 because it always runs on Node).
 */

import { makeError, q, X } from '@endo/errors';

/**
 * @import { Anchor, EditOp, EditOpKind, EditPatch } from './hashline.types.js'
 * @import { AnchorMismatch, SpliceResult } from './hashline.types.js'
 */

/**
 * The set of operation discriminants. Kept in lock-step with the
 * `EditOpKind` typedef in `hashline.types.js`.
 *
 * Per design `cli-edit-verb.md` §"Patch envelope shape": kebab-case
 * discriminants (resolved 2026-05-11 per maintainer feedback).
 */
const EDIT_OP_KINDS = harden([
  'replace',
  'replace-range',
  'delete',
  'insert-after',
  'insert-before',
  'prepend',
  'append',
]);

/** @type {Set<string>} */
const editOpKindSet = new Set(EDIT_OP_KINDS);

/**
 * The IEEE CRC32 polynomial table (precomputed once at module load).
 * @type {Uint32Array}
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Compute CRC32 (IEEE polynomial) over a UTF-8 encoded string.
 * Returns an unsigned 32-bit integer.
 *
 * @param {string} text
 * @returns {number}
 */
const crc32 = text => {
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
harden(crc32);

/**
 * Normalize a single line for hashing.
 *
 * Per design §"Hash algorithm specification" / "Default: CRC32":
 * - Strip trailing whitespace.
 * - CRLF→LF normalization (no-op here because callers split on LF
 *   already and we strip trailing whitespace which removes any \r).
 * - Preserve leading whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
const normalizeLineForHash = line => line.replace(/[ \t\r]+$/, '');
harden(normalizeLineForHash);

/**
 * Compute the per-line CRC32 anchor for `line` at 1-indexed `lineNumber`.
 *
 * Per design: encoding is 2-char lowercase hex (8 bits of CRC), or
 * 4-char hex (16 bits) for files with >4096 lines. The width is a
 * property of the *file*, not of any single line; callers pass it in.
 *
 * Per design: empty / whitespace-only lines seed the hash with the
 * line number to avoid collisions across multiple blank lines.
 *
 * @param {string} line
 * @param {number} lineNumber 1-indexed
 * @param {2|4} hexWidth
 * @returns {string} lowercase hex string of `hexWidth` characters
 */
export const lineAnchorHash = (line, lineNumber, hexWidth = 2) => {
  const normalized = normalizeLineForHash(line);
  const seedInput = normalized === '' ? `${lineNumber}` : normalized;
  const value = crc32(seedInput);
  // Take the low `hexWidth*4` bits (8 or 16) so hashing remains
  // deterministic across encoding-width upgrades when the file is
  // small enough.
  const masked = value & (hexWidth === 4 ? 0xffff : 0xff);
  return masked.toString(16).padStart(hexWidth, '0');
};
harden(lineAnchorHash);

/**
 * Pick the encoding width for a file given its line count.
 *
 * Per design: 2-char hex by default, 4-char hex for files with >4096
 * lines.
 *
 * @param {number} lineCount
 * @returns {2|4}
 */
export const anchorHexWidthForLineCount = lineCount =>
  lineCount > 4096 ? 4 : 2;
harden(anchorHexWidthForLineCount);

/**
 * Split `text` into lines for the purpose of editing.
 *
 * Per design's worked example: the input file's lines are 1-indexed,
 * and a trailing newline does NOT introduce a final empty line in
 * the index. We treat the file as a sequence of LF-terminated lines;
 * the trailing newline (if present) is restored on `joinLines`.
 *
 * **DESIGN GAP (surfaced by implementation)**: the design does not
 * pin down what happens to CRLF input or to a file that lacks a
 * trailing newline. This implementation:
 * - Treats CRLF the same as LF when splitting (CR is stripped by
 *   `normalizeLineForHash` for hashing; for the splice we preserve
 *   CR by treating only LF as the line terminator and leaving the
 *   `\r` on the line content).
 * - Records whether the input had a trailing newline so `joinLines`
 *   can preserve it (or its absence) on round-trip.
 *
 * @param {string} text
 * @returns {{ lines: string[], trailingNewline: boolean }}
 */
export const splitLines = text => {
  if (text === '') {
    return harden({ lines: [], trailingNewline: false });
  }
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  return harden({ lines, trailingNewline });
};
harden(splitLines);

/**
 * Inverse of `splitLines`: re-emit the file body.
 *
 * @param {string[]} lines
 * @param {boolean} trailingNewline
 * @returns {string}
 */
export const joinLines = (lines, trailingNewline) => {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
};
harden(joinLines);

/**
 * Validate an `Anchor` shape.
 *
 * @param {unknown} value
 * @param {string} where for diagnostic context
 * @returns {Anchor}
 */
const validateAnchor = (value, where) => {
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`${q(where)}: anchor must be an object, got ${q(value)}`);
  }
  const anchor = /** @type {Record<string, unknown>} */ (value);
  if (typeof anchor.line !== 'number' || !Number.isInteger(anchor.line)) {
    throw makeError(
      X`${q(where)}: anchor.line must be an integer, got ${q(anchor.line)}`,
    );
  }
  if (anchor.line < 1) {
    throw makeError(
      X`${q(where)}: anchor.line must be >= 1, got ${q(anchor.line)}`,
    );
  }
  if (typeof anchor.hash !== 'string' || !/^[0-9a-f]{2,4}$/.test(anchor.hash)) {
    throw makeError(
      X`${q(where)}: anchor.hash must be 2-4 lowercase hex chars, got ${q(anchor.hash)}`,
    );
  }
  return harden({ line: anchor.line, hash: anchor.hash });
};

/**
 * Validate an `EditOp` shape.
 *
 * @param {unknown} value
 * @param {number} index op index in the `ops` array
 * @returns {EditOp}
 */
const validateEditOp = (value, index) => {
  const where = `ops[${index}]`;
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`${q(where)}: must be an object, got ${q(value)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const op = raw.op;
  if (typeof op !== 'string' || !editOpKindSet.has(op)) {
    throw makeError(
      X`${q(where)}: op must be one of ${q([...EDIT_OP_KINDS])}, got ${q(op)}`,
    );
  }
  /** @type {EditOpKind} */
  const opKind = /** @type {any} */ (op);

  /** @type {Anchor=} */
  let anchor;
  /** @type {Anchor=} */
  let anchorEnd;
  /** @type {string[]=} */
  let payload;

  const needsAnchor = opKind !== 'prepend' && opKind !== 'append';
  const allowsAnchorEnd = opKind === 'replace-range' || opKind === 'delete';
  const needsPayload =
    opKind === 'replace' ||
    opKind === 'replace-range' ||
    opKind === 'insert-after' ||
    opKind === 'insert-before' ||
    opKind === 'prepend' ||
    opKind === 'append';

  if (needsAnchor) {
    anchor = validateAnchor(raw.anchor, `${where}.anchor`);
  } else if (raw.anchor !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry anchor`);
  }
  if (allowsAnchorEnd && raw.anchorEnd !== undefined) {
    anchorEnd = validateAnchor(raw.anchorEnd, `${where}.anchorEnd`);
  } else if (raw.anchorEnd !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry anchorEnd`);
  }

  if (needsPayload) {
    if (!Array.isArray(raw.payload)) {
      throw makeError(
        X`${q(where)}: ${q(opKind)} requires payload (array of strings)`,
      );
    }
    payload = raw.payload.map((line, lineIndex) => {
      if (typeof line !== 'string') {
        throw makeError(
          X`${q(where)}: payload[${q(lineIndex)}] must be a string`,
        );
      }
      return line;
    });
  } else if (raw.payload !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry payload`);
  }

  return harden({
    op: opKind,
    ...(anchor === undefined ? {} : { anchor }),
    ...(anchorEnd === undefined ? {} : { anchorEnd }),
    ...(payload === undefined ? {} : { payload: harden(payload) }),
  });
};

/**
 * Validate an `EditPatch` envelope (the `hashline-json` wire shape).
 * Returns a hardened, structurally-valid patch.
 *
 * Per design §"Format: `hashline-json` (structured, first-class)".
 *
 * @param {unknown} value
 * @returns {EditPatch}
 */
export const validateEditPatch = value => {
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`EditPatch must be an object, got ${q(value)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof raw.expectedFileHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(raw.expectedFileHash)
  ) {
    throw makeError(
      X`EditPatch.expectedFileHash must be 64-char lowercase hex SHA-256, got ${q(raw.expectedFileHash)}`,
    );
  }
  if (!Array.isArray(raw.ops)) {
    throw makeError(X`EditPatch.ops must be an array`);
  }
  const ops = raw.ops.map((op, index) => validateEditOp(op, index));
  return harden({
    expectedFileHash: raw.expectedFileHash,
    ops: harden(ops),
  });
};
harden(validateEditPatch);

/**
 * Parse the textual `hashline` patch format into an `EditPatch`.
 *
 * Per design §"Format: `hashline` (textual)":
 * - `@expected-file-hash <hex>` header (required).
 * - Operation header: `@op anchor[..anchor]` or `@op` (for prepend/append).
 * - Payload lines start with `| ` (pipe space).
 * - `#` at line start is a comment.
 * - Blank line ends an op.
 *
 * @param {string} text
 * @returns {EditPatch}
 */
export const parseHashlineText = text => {
  /** @type {string | undefined} */
  let expectedFileHash;
  /** @type {EditOp[]} */
  const ops = [];

  /** @type {EditOpKind | undefined} */
  let currentOp;
  /** @type {Anchor | undefined} */
  let currentAnchor;
  /** @type {Anchor | undefined} */
  let currentAnchorEnd;
  /** @type {string[]} */
  let currentPayload = [];

  const flush = () => {
    if (currentOp === undefined) return;
    const op = /** @type {EditOpKind} */ (currentOp);
    /** @type {Record<string, unknown>} */
    const raw = { op };
    if (currentAnchor !== undefined) raw.anchor = currentAnchor;
    if (currentAnchorEnd !== undefined) raw.anchorEnd = currentAnchorEnd;
    if (currentPayload.length > 0) raw.payload = currentPayload;
    ops.push(validateEditOp(raw, ops.length));
    currentOp = undefined;
    currentAnchor = undefined;
    currentAnchorEnd = undefined;
    currentPayload = [];
  };

  /**
   * @param {string} text2
   * @param {string} where
   * @returns {Anchor}
   */
  const parseAnchorToken = (text2, where) => {
    const match = /^(\d+)#([0-9a-f]{2,4})$/.exec(text2);
    if (match === null) {
      throw makeError(
        X`${q(where)}: malformed anchor ${q(text2)}, expected LINE#HASH`,
      );
    }
    return harden({
      line: Number.parseInt(match[1], 10),
      hash: match[2],
    });
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNum = i + 1;
    const where = `patch line ${lineNum}`;

    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('@expected-file-hash ')) {
      flush();
      const value = line.slice('@expected-file-hash '.length).trim();
      if (!/^[0-9a-f]{64}$/.test(value)) {
        throw makeError(
          X`${q(where)}: @expected-file-hash must be 64-char lowercase hex SHA-256, got ${q(value)}`,
        );
      }
      expectedFileHash = value;
      continue;
    }
    if (line.startsWith('@')) {
      flush();
      const headerBody = line.slice(1).trim();
      const spaceIdx = headerBody.indexOf(' ');
      const opToken =
        spaceIdx === -1 ? headerBody : headerBody.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? '' : headerBody.slice(spaceIdx + 1).trim();
      if (!editOpKindSet.has(opToken)) {
        throw makeError(
          X`${q(where)}: unknown op ${q(opToken)}; expected one of ${q([
            ...EDIT_OP_KINDS,
          ])}`,
        );
      }
      currentOp = /** @type {EditOpKind} */ (opToken);
      if (currentOp === 'prepend' || currentOp === 'append') {
        if (rest !== '') {
          throw makeError(
            X`${q(where)}: ${q(currentOp)} takes no anchor, got ${q(rest)}`,
          );
        }
      } else {
        if (rest === '') {
          throw makeError(X`${q(where)}: ${q(currentOp)} requires an anchor`);
        }
        const rangeIdx = rest.indexOf('..');
        if (rangeIdx === -1) {
          currentAnchor = parseAnchorToken(rest, where);
        } else {
          currentAnchor = parseAnchorToken(rest.slice(0, rangeIdx), where);
          currentAnchorEnd = parseAnchorToken(rest.slice(rangeIdx + 2), where);
        }
      }
      continue;
    }
    if (line.startsWith('| ')) {
      currentPayload.push(line.slice(2));
      continue;
    }
    if (line === '|') {
      currentPayload.push('');
      continue;
    }
    throw makeError(
      X`${q(where)}: unexpected line ${q(line)}; expected @op header, | payload, # comment, or blank line`,
    );
  }
  flush();

  if (expectedFileHash === undefined) {
    throw makeError(
      X`hashline patch: missing required @expected-file-hash header`,
    );
  }

  return harden({ expectedFileHash, ops: harden(ops) });
};
harden(parseHashlineText);

/**
 * Order ops bottom-up by line number. Per design §"Atomic batch":
 * "Multiple operations in one patch are sorted bottom-up by line
 * number and applied as one splice pass, so anchors earlier in the
 * patch keep referring to their original positions."
 *
 * Ops without an anchor (prepend/append) are placed at sentinel
 * positions: prepend at `-Infinity` (applied first when iterating
 * bottom-up so it lands at line 0), append at `+Infinity` (applied
 * last so it lands after the original final line).
 *
 * **DESIGN GAP**: the design does not pin down ordering when two ops
 * share the same line number (e.g., a `replace 5#xx` next to an
 * `insert-after 5#xx`). This implementation's tiebreaker: `delete`/
 * `replace`/`replace-range` apply *after* `insert-before`/
 * `insert-after` at the same anchor, so the inserts land relative to
 * the pre-replace line. We sort stably by (lineEnd desc, kindRank).
 *
 * @param {EditOp[]} ops
 * @returns {EditOp[]}
 */
const sortBottomUp = ops => {
  /** @param {EditOp} o */
  const sortLineEnd = o => {
    if (o.op === 'prepend') return -Infinity;
    if (o.op === 'append') return Infinity;
    if (o.anchorEnd !== undefined) return o.anchorEnd.line;
    return /** @type {Anchor} */ (o.anchor).line;
  };
  /** @param {EditOpKind} kind */
  const kindRank = kind => {
    // Lower rank applies later (we iterate the sorted array from
    // tail forward, so higher line numbers come first). Within a
    // line, inserts ought to apply *after* replaces in our
    // iteration order so that the replace operates on pre-insert
    // content; that means inserts get the higher rank.
    switch (kind) {
      case 'replace':
      case 'replace-range':
      case 'delete':
        return 0;
      case 'insert-before':
        return 1;
      case 'insert-after':
        return 2;
      default:
        return 3;
    }
  };
  return [...ops].sort((a, b) => {
    const la = sortLineEnd(a);
    const lb = sortLineEnd(b);
    if (la !== lb) return la - lb;
    return kindRank(a.op) - kindRank(b.op);
  });
};

/**
 * Validate per-line anchors against the file's current contents and
 * return a list of mismatches (empty if all anchors validate).
 *
 * @param {EditPatch} patch
 * @param {string[]} lines
 * @returns {AnchorMismatch[]}
 */
export const validateAnchors = (patch, lines) => {
  const hexWidth = anchorHexWidthForLineCount(lines.length);
  /** @type {AnchorMismatch[]} */
  const mismatches = [];
  /** @param {Anchor} anchor */
  const checkAnchor = anchor => {
    if (anchor.line > lines.length) {
      mismatches.push(
        harden({
          line: anchor.line,
          hashExpected: anchor.hash,
          hashActual: '',
        }),
      );
      return;
    }
    const actual = lineAnchorHash(
      lines[anchor.line - 1],
      anchor.line,
      /** @type {2|4} */ (anchor.hash.length),
    );
    // Permit the patch to use either width; recompute at the patch's
    // declared width for the comparison. If the file is large enough
    // to require 4-char width but the patch supplied 2, recompute at 2.
    if (actual !== anchor.hash) {
      mismatches.push(
        harden({
          line: anchor.line,
          hashExpected: anchor.hash,
          hashActual: lineAnchorHash(
            lines[anchor.line - 1],
            anchor.line,
            hexWidth,
          ),
        }),
      );
    }
  };
  for (const op of patch.ops) {
    if (op.anchor !== undefined) checkAnchor(op.anchor);
    if (op.anchorEnd !== undefined) checkAnchor(op.anchorEnd);
  }
  return harden(mismatches);
};
harden(validateAnchors);

/**
 * Apply a sequence of validated ops to `lines` and return the new
 * line array. Bottom-up splice; idempotent on the input (does not
 * mutate).
 *
 * The caller is responsible for having already validated anchors and
 * the file-rev CAS hash.
 *
 * @param {EditPatch} patch
 * @param {string[]} lines
 * @returns {SpliceResult}
 */
export const applyPatch = (patch, lines) => {
  const sorted = sortBottomUp(patch.ops);
  /** @type {string[]} */
  const result = [...lines];
  // Iterate from the back so earlier-listed ops still see their
  // anchors at the original positions (their splice has not yet
  // shifted any line they reference).
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const op = sorted[i];
    switch (op.op) {
      case 'replace': {
        const at = /** @type {Anchor} */ (op.anchor).line - 1;
        result.splice(at, 1, .../** @type {string[]} */ (op.payload));
        break;
      }
      case 'replace-range': {
        const start = /** @type {Anchor} */ (op.anchor).line - 1;
        const end = /** @type {Anchor} */ (op.anchorEnd).line - 1;
        if (end < start) {
          throw makeError(
            X`replace-range: anchorEnd.line ${q(end + 1)} must be >= anchor.line ${q(start + 1)}`,
          );
        }
        result.splice(
          start,
          end - start + 1,
          .../** @type {string[]} */ (op.payload),
        );
        break;
      }
      case 'delete': {
        const start = /** @type {Anchor} */ (op.anchor).line - 1;
        const end = op.anchorEnd === undefined ? start : op.anchorEnd.line - 1;
        if (end < start) {
          throw makeError(
            X`delete: anchorEnd.line ${q(end + 1)} must be >= anchor.line ${q(start + 1)}`,
          );
        }
        result.splice(start, end - start + 1);
        break;
      }
      case 'insert-after': {
        const at = /** @type {Anchor} */ (op.anchor).line;
        result.splice(at, 0, .../** @type {string[]} */ (op.payload));
        break;
      }
      case 'insert-before': {
        const at = /** @type {Anchor} */ (op.anchor).line - 1;
        result.splice(at, 0, .../** @type {string[]} */ (op.payload));
        break;
      }
      case 'prepend': {
        result.splice(0, 0, .../** @type {string[]} */ (op.payload));
        break;
      }
      case 'append': {
        result.splice(
          result.length,
          0,
          .../** @type {string[]} */ (op.payload),
        );
        break;
      }
      default:
        throw makeError(X`unreachable op ${q(op.op)}`);
    }
  }
  return harden({ lines: harden(result) });
};
harden(applyPatch);
