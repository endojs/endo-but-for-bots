// @ts-check
/// <reference types="ses"/>

/**
 * Hashline: parser, validator, renderer, and pure splice for the
 * hash-anchored line-based edit format of `designs/cli-edit-verb.md`.
 *
 * This module is the shared pure core that the daemon-side
 * `EndoMount.edit` / `EndoGuest.edit` capability and the CLI's
 * `endo edit` verb both call into, so the agent's view and the
 * daemon's view of a patch agree byte-for-byte. It performs no I/O
 * and holds no locks; the mount layer owns the read-splice-write
 * critical section, the file-size cap and the total payload volume it
 * accepts (line count and total characters), and the `path-not-found` /
 * `permission-denied` failure reasons. This core additionally caps the
 * one dimension whose overflow would otherwise escape the structured
 * failure contract as a raw engine `RangeError`: the spliced result's
 * character length, against the engine string-length ceiling
 * (`MAX_RESULT_CHARS`), reported as a `patch-syntax` failure.
 *
 * Wire contract (v1, fixed):
 * - Per-line anchor hash: CRC32 (IEEE polynomial) over the
 *   normalized line (trailing whitespace stripped — exactly the code
 *   points U+0020 SPACE, U+0009 TAB, and U+000D CR, which subsumes
 *   CRLF-to-LF normalization; *not* the broader Unicode whitespace set
 *   `String.prototype.trimEnd` strips — leading whitespace preserved;
 *   blank lines seeded with a
 *   leading-LF line-number sentinel — `\n${lineNumber}` — whose byte
 *   space is disjoint from any content line, so a blank line never
 *   collides with a bare-digit content line). Encoded as 2-char
 *   lowercase hex for files of at most 4096 lines, 4-char above.
 * - Whole-file CAS hash: SHA-256, 64-char lowercase hex, always.
 *   The SHA-256 function is injected (`sha256Hex` power) so this
 *   module stays pure and platform-neutral.
 * - Anchor and payload content domain: well-formed UTF-16. Both the
 *   CRC32 anchor and the SHA-256 CAS hash the UTF-8 encoding of their
 *   input, and `TextEncoder` maps every unpaired surrogate to U+FFFD —
 *   so an unpaired surrogate is not injective under the hash (distinct
 *   strings share one hash input) and cannot round-trip a UTF-8 write.
 *   Payload lines carrying an unpaired surrogate are rejected alongside
 *   embedded LF/CR.
 */

import { bytesFromText } from '@endo/bytes/from-string.js';
import { crc32 } from '@endo/crc32';
import { makeError, q, X } from '@endo/errors';
import { isWellFormedString } from '@endo/pass-style';

/**
 * @import {
 *   HashlineAnchor,
 *   HashlineEditOpKind,
 *   HashlineEditOp,
 *   HashlineEditPatch,
 *   HashlineAnchorMismatch,
 *   HashlineReapplyAmbiguity,
 *   HashlineEditFailure,
 *   HashlineAnchorRelocation,
 *   HashlineEditResult,
 *   HashlineSpliceOutcome,
 *   Sha256HexFn,
 *   HashlineApplyEditOptions,
 * } from './types.js'
 */

/**
 * Validate every element of an untrusted array by an explicit indexed loop to
 * a length captured exactly once, returning the validated elements. This is
 * safer than `array.map(validate)` two ways: `Array.prototype.map` skips holes,
 * so a sparse array (`[ , x]`) would slip an unvalidated `undefined` past the
 * per-element guard and later throw a raw `TypeError` out of the
 * structured-failure contract; and mapping through the array's own `map` is not
 * safe against a proxy-over-array whose `map` is a trap (`Array.isArray` is
 * `true` for such a proxy). Reading `length` once also closes the TOCTOU where
 * a proxy reports one length to a cap check and another to the mapper — the
 * caller passes the same captured `count` it bounded.
 *
 * @template T
 * @param {ArrayLike<unknown>} array
 * @param {number} count the already-captured, already-bounded `array.length`
 * @param {(value: unknown, index: number) => T} validate
 * @returns {T[]}
 */
const validateElements = (array, count, validate) => {
  /** @type {T[]} */
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(validate(array[index], index));
  }
  return result;
};

/**
 * Append every element of `items` to `target` in order, without spreading
 * `items` into a call. A caller-controlled payload spread as `push(...items)`
 * / `splice(_, _, ...items)` becomes an argument-count `RangeError` — an
 * engine-dependent throw (it trips far sooner under XS's slot-budgeted stack)
 * that escapes the structured-failure contract — so payload assembly appends
 * element by element instead.
 *
 * @param {string[]} target
 * @param {string[]} items
 */
const appendAll = (target, items) => {
  for (let index = 0; index < items.length; index += 1) {
    target.push(items[index]);
  }
};

/**
 * Cap on the number of operations in one patch. Bounds the reapply search
 * (a per-anchor CRC scan) so a pathological op count cannot turn one edit
 * into unbounded synchronous CPU, and yields a structured `patch-syntax`
 * failure rather than a throw.
 */
const MAX_EDIT_OPS = 10_000;

/**
 * Cap on the spliced result's character length, checked before `joinLines`
 * builds the single result string. A caller-controlled payload is otherwise
 * unbounded in total characters (`MAX_EDIT_OPS` bounds the op *count*, not the
 * bytes each op carries), and a result past the engine's maximum string length
 * makes `joinLines` throw a raw `RangeError: Invalid string length` — an
 * engine-dependent throw that escapes the structured-failure contract this
 * module promises. 256 MiB sits comfortably under V8's ~512 MiB string ceiling
 * yet far above any realistic edited file, so overflow is reported as a
 * `patch-syntax` failure rather than thrown. Total payload *volume* (as opposed
 * to this single overflow guard) is the mount's to bound, per the header.
 */
const MAX_RESULT_CHARS = 0x1000_0000;

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
 * SHA-256 of the empty byte string: the canonical `expectedFileHash`
 * of an empty file.
 */
export const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const REAPPLY_WINDOW_DEFAULT = 20;
const REAPPLY_WINDOW_MAX = 200;

/**
 * Normalize a line for anchor hashing: strip trailing whitespace —
 * exactly the code points U+0020 SPACE, U+0009 TAB, and U+000D CR (which
 * subsumes CRLF-to-LF normalization, since a trailing `\r` is one of
 * them), and deliberately *not* the wider set `String.prototype.trimEnd`
 * removes (U+000B, U+000C, U+00A0, U+2028, U+FEFF, ...): the stripped set
 * is part of the wire contract, so an independent implementer must strip
 * these three and only these, or a line ending in U+00A0 (which
 * `.trimEnd` removes and this scan keeps) would anchor differently
 * across implementations. Leading whitespace is preserved.
 *
 * Implemented as an explicit backward scan rather than a
 * `line.replace(/[ \t\r]+$/, '')`: the anchored-`$` regex backtracks
 * quadratically in line length on V8 (a 160k-space line measured at
 * ~13s), and nothing in this module or the design caps a single line's
 * length, so a hostile long-whitespace line could otherwise wedge the
 * mount's synchronous read-splice-write section. The scan is linear.
 *
 * @param {string} line
 * @returns {string}
 */
const normalizeLineForHash = line => {
  let end = line.length;
  while (end > 0) {
    const code = line.charCodeAt(end - 1);
    // space (0x20), tab (0x09), carriage return (0x0d)
    if (code === 0x20 || code === 0x09 || code === 0x0d) {
      end -= 1;
    } else {
      break;
    }
  }
  return end === line.length ? line : line.slice(0, end);
};

/**
 * The per-line CRC32 anchor of `line` at 1-indexed `lineNumber`.
 * Empty and whitespace-only lines are seeded with the line number so
 * consecutive blank lines do not share an anchor. The seed carries a
 * leading LF (`\n${lineNumber}`), a byte no content line can contain
 * (lines are split on LF, so a normalized content line never holds
 * one), so a blank line's anchor can never share a hash *input* with a
 * real content line whose text is the bare digits of that line number
 * — the seed space and the content space are disjoint by construction.
 * Without the sentinel, a blank line at line `N` and a content line
 * whose trimmed text is literally `"N"` (a bare index or list marker)
 * would hash identically, deterministically defeating both the strict
 * anchor check and the reapply ambiguity guard rather than colliding at
 * the hash's inherent 1/256 rate.
 *
 * @param {string} line
 * @param {number} lineNumber 1-indexed
 * @param {2 | 4} [hexWidth] the anchor width; the module's whole width family
 *   is 2 or 4, so the type — not a runtime guard — pins the domain (a stray
 *   width like 3 would silently mask to a 3-char string no anchor accepts)
 * @returns {string} lowercase hex of `hexWidth` characters
 */
export const lineAnchorHash = (line, lineNumber, hexWidth = 2) => {
  const normalized = normalizeLineForHash(line);
  const input = normalized === '' ? `\n${lineNumber}` : normalized;
  const masked =
    crc32(bytesFromText(input)) % (hexWidth === 4 ? 0x1_0000 : 0x100);
  return masked.toString(16).padStart(hexWidth, '0');
};
harden(lineAnchorHash);

/**
 * The file's native anchor width: 2-char hex for files of at most
 * 4096 lines, 4-char above.
 *
 * @param {number} lineCount
 * @returns {2 | 4}
 */
export const anchorHexWidthForLineCount = lineCount =>
  lineCount > 4096 ? 4 : 2;
harden(anchorHexWidthForLineCount);

/**
 * Split file text into lines on LF only. A `\r` preceding an LF stays
 * on the line content so the splice round-trips CRLF byte-for-byte.
 * `trailingNewline` is true when the final byte is LF, and for the
 * empty file.
 *
 * @param {string} text
 * @returns {{ lines: string[], trailingNewline: boolean }}
 */
export const splitLines = text => {
  if (text === '') {
    return harden({ lines: [], trailingNewline: true });
  }
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return harden({ lines: body.split('\n'), trailingNewline });
};
harden(splitLines);

/**
 * Inverse of `splitLines`.
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
 * Render the hashline-annotated view of a file: each line prefixed
 * with `LINE#HASH`, line numbers right-aligned to the widest line
 * number, at the file's native anchor width.
 *
 * @param {string} text
 * @returns {string[]} annotated lines
 */
export const renderHashlineLines = text => {
  const { lines } = splitLines(text);
  const hexWidth = anchorHexWidthForLineCount(lines.length);
  const numberWidth = `${lines.length}`.length;
  return harden(
    lines.map((line, index) => {
      const lineNumber = index + 1;
      const anchor = `${`${lineNumber}`.padStart(numberWidth)}#${lineAnchorHash(
        line,
        lineNumber,
        hexWidth,
      )}`;
      return line === '' ? anchor : `${anchor} ${line}`;
    }),
  );
};
harden(renderHashlineLines);

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {HashlineAnchor}
 */
const validateAnchor = (value, where) => {
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`${q(where)}: anchor must be an object, got ${q(value)}`);
  }
  const anchor = /** @type {Record<string, unknown>} */ (value);
  // Read each untrusted property exactly once: a getter that returned a
  // different value per access would otherwise pass the guard and yield a
  // different value into the hardened result.
  const { line, hash } = anchor;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw makeError(
      X`${q(where)}: anchor.line must be a positive integer, got ${q(line)}`,
    );
  }
  if (typeof hash !== 'string' || !/^(?:[0-9a-f]{2}|[0-9a-f]{4})$/.test(hash)) {
    throw makeError(
      X`${q(where)}: anchor.hash must be exactly 2 or 4 lowercase hex chars, got ${q(hash)}`,
    );
  }
  return harden({ line, hash });
};

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {HashlineEditOp}
 */
const validateEditOp = (value, index) => {
  const where = `ops[${index}]`;
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`${q(where)}: must be an object, got ${q(value)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const { op } = raw;
  if (typeof op !== 'string' || !editOpKindSet.has(op)) {
    throw makeError(
      X`${q(where)}: op must be one of ${q([...EDIT_OP_KINDS])}, got ${q(op)}`,
    );
  }
  const opKind = /** @type {HashlineEditOpKind} */ (op);

  const needsAnchor = opKind !== 'prepend' && opKind !== 'append';
  const needsAnchorEnd = opKind === 'replace-range';
  const allowsAnchorEnd = needsAnchorEnd || opKind === 'delete';
  const needsPayload = opKind !== 'delete';

  // Read each untrusted property exactly once: a getter on the passed
  // object that returned a different value per access would otherwise
  // defeat the guard-then-use re-validation the branches below rely on.
  const rawAnchor = raw.anchor;
  const rawAnchorEnd = raw.anchorEnd;
  const rawPayload = raw.payload;

  /** @type {HashlineAnchor | undefined} */
  let anchor;
  /** @type {HashlineAnchor | undefined} */
  let anchorEnd;
  /** @type {string[] | undefined} */
  let payload;

  if (needsAnchor) {
    anchor = validateAnchor(rawAnchor, `${where}.anchor`);
  } else if (rawAnchor !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry anchor`);
  }
  if (allowsAnchorEnd && rawAnchorEnd !== undefined) {
    anchorEnd = validateAnchor(rawAnchorEnd, `${where}.anchorEnd`);
  } else if (rawAnchorEnd !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry anchorEnd`);
  }
  if (needsAnchorEnd && anchorEnd === undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} requires anchorEnd`);
  }
  if (
    anchor !== undefined &&
    anchorEnd !== undefined &&
    anchorEnd.line < anchor.line
  ) {
    throw makeError(
      X`${q(where)}: anchorEnd.line ${q(anchorEnd.line)} must be >= anchor.line ${q(anchor.line)}`,
    );
  }

  if (needsPayload) {
    if (!Array.isArray(rawPayload)) {
      throw makeError(
        X`${q(where)}: ${q(opKind)} requires payload (array of strings)`,
      );
    }
    // Read the untrusted length exactly once and cap it before iterating.
    // `Array.isArray` is `true` for a proxy-over-array (a threat this module
    // names and the suite tests), so a ~50-byte proxy declaring
    // `length: 2**31` and answering every index would otherwise spin the
    // validator for order-of-an-hour of synchronous CPU inside the mount's
    // read-splice-write critical section, before `MAX_RESULT_CHARS` (which
    // guards the downstream `join`, not this allocation) could fire. No real
    // patch inserts more lines than the spliced result may hold characters, so
    // the same `MAX_RESULT_CHARS` envelope bounds the payload line count.
    const payloadLength = rawPayload.length;
    if (
      !Number.isSafeInteger(payloadLength) ||
      payloadLength < 0 ||
      payloadLength > MAX_RESULT_CHARS
    ) {
      throw makeError(
        X`${q(where)}: ${q(opKind)} payload must hold at most ${q(MAX_RESULT_CHARS)} lines, got ${q(payloadLength)}`,
      );
    }
    // Validate by an explicit indexed loop, not `.map`: `.map` skips holes (a
    // sparse `[ , 'x']` would leave a hole no guard saw, which splices as an
    // empty line and later throws out of the structured-failure contract), and
    // `Array.isArray` is `true` for a proxy over an array whose own `map` is a
    // trap. A trailing/embedded CR is rejected alongside LF: one payload entry
    // is exactly one physical line, and a smuggled `\r` would inject a stray
    // carriage return the anchor accounting never sees (see `parseHashlineText`
    // for the textual-transport CRLF handling).
    payload = validateElements(
      rawPayload,
      payloadLength,
      (/** @type {unknown} */ line, /** @type {number} */ lineIndex) => {
        if (typeof line !== 'string') {
          throw makeError(
            X`${q(where)}: payload[${q(lineIndex)}] must be a string`,
          );
        }
        if (line.includes('\n') || line.includes('\r')) {
          throw makeError(
            X`${q(where)}: payload[${q(lineIndex)}] must not contain an embedded newline or carriage return; express multi-line insertion as multiple payload entries`,
          );
        }
        // Reject unpaired surrogates: the anchor CRC32 and the CAS SHA-256 both
        // hash the UTF-8 encoding, and `TextEncoder` folds every unpaired
        // surrogate to U+FFFD — so an unpaired surrogate is not injective under
        // either hash (`'a\uD800b'` and `'a�b'` share one hash input,
        // deterministically defeating the strict anchor check and the reapply
        // uniqueness guard) and cannot round-trip a UTF-8 write, making the
        // returned `newText` disagree with the bytes `fileHashAfter` describes.
        // Use `@endo/pass-style`'s `isWellFormedString`, not the raw
        // `String.prototype.isWellFormed` native method: not every engine the
        // daemon's workers run on carries the built-in (XS among them, and this
        // package ships XS workers), and reaching for the native method directly
        // would make every payload-carrying edit throw a raw `TypeError` — out of
        // this module's structured-failure contract — on such an engine.
        if (!isWellFormedString(line)) {
          throw makeError(
            X`${q(where)}: payload[${q(lineIndex)}] must be well-formed UTF-16 (no unpaired surrogate); the anchor and CAS hashes are injective only over well-formed text`,
          );
        }
        return line;
      },
    );
  } else if (rawPayload !== undefined) {
    throw makeError(X`${q(where)}: ${q(opKind)} must not carry payload`);
  }

  // The presence of anchor/anchorEnd/payload was just enforced per kind above,
  // so this assembled record satisfies the `HashlineEditOp` discriminated union; the
  // cast is the single validation-boundary bridge TS cannot infer from the
  // imperative guards (downstream code narrows on `op` and needs no casts).
  return /** @type {HashlineEditOp} */ (
    harden({
      op: opKind,
      ...(anchor === undefined ? {} : { anchor }),
      ...(anchorEnd === undefined ? {} : { anchorEnd }),
      ...(payload === undefined ? {} : { payload: harden(payload) }),
    })
  );
};

/**
 * Validate a `HashlineEditPatch` envelope (the `hashline-json` wire shape).
 * Throws on any malformation; returns a hardened, structurally-valid
 * patch. The mount layer re-runs this on entry regardless of what an
 * intermediate hop claims to have validated.
 *
 * @param {unknown} value
 * @returns {HashlineEditPatch}
 */
export const validateEditPatch = value => {
  if (typeof value !== 'object' || value === null) {
    throw makeError(X`HashlineEditPatch must be an object, got ${q(value)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  // Read each untrusted property exactly once (see `validateAnchor`): a getter
  // that turned hostile on a later access would otherwise yield a hardened
  // patch carrying a value the guards below never saw.
  const { expectedFileHash, ops } = raw;
  if (
    typeof expectedFileHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expectedFileHash)
  ) {
    throw makeError(
      X`HashlineEditPatch.expectedFileHash must be 64-char lowercase hex SHA-256, got ${q(expectedFileHash)}`,
    );
  }
  if (!Array.isArray(ops)) {
    throw makeError(X`HashlineEditPatch.ops must be an array`);
  }
  // Capture the op count exactly once: the cap check and the validation loop
  // must read the same length, or a proxy-over-array could report a small
  // length to the cap and a large one to the mapper (a TOCTOU amplifying the
  // reapply search into unbounded synchronous CPU). Validate it as a
  // non-negative safe integer in the same shape as the `payloadLength` guard
  // above (`Array.isArray` is `true` for a proxy-over-array, and array `length`
  // is writable, so a `get` trap returning `NaN`/`-1`/`undefined` otherwise
  // slips past a bare `> MAX_EDIT_OPS` comparison — `NaN`/`undefined`
  // comparisons are false — making `validateElements`' `index < count` check
  // vacuously false, so the loop never runs and the patch validates to an EMPTY
  // `ops` list: `applyEditPatch` would then report `success: true` for a patch
  // whose every operation was silently dropped.
  const opCount = ops.length;
  if (!Number.isSafeInteger(opCount) || opCount < 0 || opCount > MAX_EDIT_OPS) {
    throw makeError(
      X`HashlineEditPatch.ops must hold at most ${q(MAX_EDIT_OPS)} operations, got ${q(opCount)}`,
    );
  }
  return harden({
    expectedFileHash,
    // Validate by explicit indexed loop over the captured count (see
    // `validateElements`): `.map` skips holes, so a sparse `ops` array would
    // slip an unvalidated hole past `validateEditOp` and throw a raw
    // `TypeError` out of the structured-failure contract downstream.
    ops: harden(
      validateElements(ops, opCount, (/** @type {unknown} */ op, index) =>
        validateEditOp(op, index),
      ),
    ),
  });
};
harden(validateEditPatch);

/**
 * Parse the textual `hashline` patch format into a `HashlineEditPatch`.
 * Throws on any syntax error.
 *
 * Grammar per the design: an `@expected-file-hash <hex>` header
 * (required), operation headers `@op anchor[..anchor]`, payload lines
 * prefixed `| ` (a bare `|` is an empty payload line), `#` comments,
 * and blank lines ending an operation.
 *
 * @param {string} text
 * @returns {HashlineEditPatch}
 */
export const parseHashlineText = text => {
  /** @type {string | undefined} */
  let expectedFileHash;
  /** @type {HashlineEditOp[]} */
  const ops = [];

  /** @type {string | undefined} */
  let currentOp;
  /** @type {HashlineAnchor | undefined} */
  let currentAnchor;
  /** @type {HashlineAnchor | undefined} */
  let currentAnchorEnd;
  /** @type {string[]} */
  let currentPayload = [];
  let currentHasPayload = false;

  const flush = () => {
    if (currentOp === undefined) {
      return;
    }
    /** @type {Record<string, unknown>} */
    const raw = { op: currentOp };
    if (currentAnchor !== undefined) {
      raw.anchor = currentAnchor;
    }
    if (currentAnchorEnd !== undefined) {
      raw.anchorEnd = currentAnchorEnd;
    }
    if (currentHasPayload) {
      raw.payload = currentPayload;
    }
    // Enforce the same `MAX_EDIT_OPS` envelope cap the structured
    // (`validateEditPatch`) reader enforces, and enforce it here in the parse
    // loop so the cap fires before the over-cap op is built rather than after
    // `applyEditPatch` re-validates a fully-materialized over-cap patch: the two
    // readers of one wire format must agree on every limit.
    if (ops.length >= MAX_EDIT_OPS) {
      throw makeError(
        X`hashline patch: too many operations, at most ${q(MAX_EDIT_OPS)} allowed`,
      );
    }
    ops.push(validateEditOp(raw, ops.length));
    currentOp = undefined;
    currentAnchor = undefined;
    currentAnchorEnd = undefined;
    currentPayload = [];
    currentHasPayload = false;
  };

  /**
   * @param {string} token
   * @param {string} where
   * @returns {HashlineAnchor}
   */
  const parseAnchorToken = (token, where) => {
    const match = /^(\d+)#([0-9a-f]{2}|[0-9a-f]{4})$/.exec(token);
    if (match === null) {
      throw makeError(
        X`${q(where)}: malformed anchor ${q(token)}, expected LINE#HASH`,
      );
    }
    return harden({ line: Number.parseInt(match[1], 10), hash: match[2] });
  };

  // Split on LF and strip a single trailing CR per line, so a CRLF-authored
  // patch (a Windows editor, `core.autocrlf=true`, an HTML form submission —
  // the near-term `endo edit --patch <file>`/stdin path) parses identically to
  // an LF-authored one. Without this a payload line would carry a stray `\r`
  // into the spliced file (invisible, since `normalizeLineForHash` strips it
  // from every later anchor check) and a CRLF blank separator would misparse
  // as `unexpected line "\r"`. The `hashline-json` payload validator rejects
  // an embedded CR outright; here the CR is a transport artifact, so it is
  // stripped rather than rejected.
  const patchLines = text
    .split('\n')
    .map(patchLine =>
      patchLine.endsWith('\r') ? patchLine.slice(0, -1) : patchLine,
    );
  for (
    let patchLineIndex = 0;
    patchLineIndex < patchLines.length;
    patchLineIndex += 1
  ) {
    const line = patchLines[patchLineIndex];
    const where = `patch line ${patchLineIndex + 1}`;

    if (line === '') {
      flush();
    } else if (line.startsWith('#')) {
      // Comment; ignored.
    } else if (line.startsWith('@expected-file-hash ')) {
      flush();
      if (expectedFileHash !== undefined) {
        throw makeError(
          X`${q(where)}: duplicate @expected-file-hash header; a patch declares exactly one file revision`,
        );
      }
      const value = line.slice('@expected-file-hash '.length).trim();
      if (!/^[0-9a-f]{64}$/.test(value)) {
        throw makeError(
          X`${q(where)}: @expected-file-hash must be 64-char lowercase hex SHA-256, got ${q(value)}`,
        );
      }
      expectedFileHash = value;
    } else if (line.startsWith('@')) {
      flush();
      const headerBody = line.slice(1).trim();
      const spaceIndex = headerBody.indexOf(' ');
      const opToken =
        spaceIndex === -1 ? headerBody : headerBody.slice(0, spaceIndex);
      const rest =
        spaceIndex === -1 ? '' : headerBody.slice(spaceIndex + 1).trim();
      if (!editOpKindSet.has(opToken)) {
        throw makeError(
          X`${q(where)}: unknown op ${q(opToken)}; expected one of ${q([...EDIT_OP_KINDS])}`,
        );
      }
      currentOp = opToken;
      if (opToken === 'prepend' || opToken === 'append') {
        if (rest !== '') {
          throw makeError(
            X`${q(where)}: ${q(opToken)} takes no anchor, got ${q(rest)}`,
          );
        }
      } else {
        if (rest === '') {
          throw makeError(X`${q(where)}: ${q(opToken)} requires an anchor`);
        }
        const rangeIndex = rest.indexOf('..');
        if (rangeIndex === -1) {
          currentAnchor = parseAnchorToken(rest, where);
        } else {
          currentAnchor = parseAnchorToken(rest.slice(0, rangeIndex), where);
          currentAnchorEnd = parseAnchorToken(
            rest.slice(rangeIndex + 2),
            where,
          );
          if (currentOp === 'replace') {
            // The textual grammar spells a ranged replace as
            // `@replace A..B`; the envelope discriminant is
            // `replace-range`.
            currentOp = 'replace-range';
          }
        }
      }
    } else if (line.startsWith('| ') || line === '|') {
      if (currentOp === undefined) {
        throw makeError(X`${q(where)}: payload line outside any @op operation`);
      }
      currentPayload.push(line === '|' ? '' : line.slice(2));
      currentHasPayload = true;
    } else {
      throw makeError(
        X`${q(where)}: unexpected line ${q(line)}; expected @op header, | payload, # comment, or blank line`,
      );
    }
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
 * The inclusive line span an op consumes, or undefined for pure
 * inserts.
 *
 * @param {HashlineEditOp} op
 * @returns {{ start: number, end: number } | undefined}
 */
const consumedSpan = op => {
  if (op.op === 'replace') {
    return { start: op.anchor.line, end: op.anchor.line };
  }
  if (op.op === 'delete') {
    const end = op.anchorEnd === undefined ? op.anchor.line : op.anchorEnd.line;
    return { start: op.anchor.line, end };
  }
  if (op.op === 'replace-range') {
    return { start: op.anchor.line, end: op.anchorEnd.line };
  }
  return undefined;
};

/**
 * The anchors an op carries, in validation order (start before end). Empty for
 * `prepend`/`append`. Narrowing per kind lets callers iterate an op's anchors
 * without reading `anchor`/`anchorEnd` off a union member that lacks them.
 *
 * @param {HashlineEditOp} op
 * @returns {HashlineAnchor[]}
 */
const opAnchors = op => {
  switch (op.op) {
    case 'prepend':
    case 'append':
      return [];
    case 'delete':
      return op.anchorEnd === undefined
        ? [op.anchor]
        : [op.anchor, op.anchorEnd];
    case 'replace-range':
      return [op.anchor, op.anchorEnd];
    default:
      return [op.anchor];
  }
};

/**
 * A failure `HashlineSpliceOutcome`: the boundary-safe failure `result` and no
 * `newText` (nothing was spliced).
 *
 * @param {string} fileHashActual
 * @param {HashlineEditFailure['reason']} reason
 * @param {string} message
 * @param {Partial<HashlineEditFailure>} [extra]
 * @returns {HashlineSpliceOutcome}
 */
const failureOutcome = (fileHashActual, reason, message, extra = {}) =>
  harden({
    result: harden({
      success: false,
      fileHashAfter: fileHashActual,
      failure: { reason, fileHashActual, message, ...extra },
    }),
  });

/**
 * Coerce a caught value into a human-readable diagnostic string. The module's
 * threat model posits a hostile proxy-over-array whose validation trap may
 * `throw 42` (a non-`Error`, so `.message` is `undefined`) or `throw undefined`
 * (so reading `.message` is itself a raw `TypeError` escaping the
 * structured-failure contract). Read `.message` only from a genuine `Error`,
 * and coerce anything else through a guarded `String`. The guard is for a
 * hostile `toString`/`@@toPrimitive` that throws — not for a symbol, which
 * `String(symbol)` stringifies to `"Symbol(...)"` rather than throwing (so
 * "simplifying" this to a template literal `${error}` would newly throw on the
 * very symbol case the `String` form handles).
 *
 * The `instanceof Error` brand check and the `.message` read are BOTH inside
 * the `try`: `instanceof` only walks the prototype chain (an `Object.create(
 * Error.prototype, { message: { get() { throw } } })`, or even a genuine
 * `Error` with a throwing own `message` accessor, passes the brand), and
 * `.message` is then a plain `[[Get]]` an accessor can trap — so reading either
 * outside the `try` would let a guest-crafted throw escape `applyEditPatch` as
 * a raw throw, carrying the guest's live object across the mount boundary
 * instead of a hardened failure record. A `.message` that reads without
 * throwing but is not a string falls through to the guarded `String` coercion.
 *
 * @param {unknown} error
 * @returns {string}
 */
const errorMessage = error => {
  try {
    if (error instanceof Error) {
      const { message } = error;
      if (typeof message === 'string') {
        return message;
      }
    }
    return `patch validation threw a non-error value: ${String(error)}`;
  } catch {
    return 'patch validation threw a non-error, non-stringifiable value';
  }
};

/**
 * Apply a `HashlineEditPatch` to file text, enforcing the SHA-256
 * file-rev CAS and per-line anchor validation, and return a
 * `HashlineSpliceOutcome`: the boundary-safe `result` (a structured success or
 * failure) and, on success only, the spliced `newText` on a separate
 * channel. Pure: the caller reads the file before and writes `newText`
 * after, under whatever lock the backing store requires.
 *
 * The digest power `sha256Hex` is a distinct positional parameter, NOT a
 * member of `options`: a mount forwarding a guest-authored `options`
 * object must not be able to occupy the power's slot (a guest in the
 * `sha256Hex` slot would receive every byte of file plaintext and could
 * defeat the file-rev CAS by returning the expected hash). And `newText`
 * is returned OFF the `result` so a mount cannot leak the whole file by
 * forwarding the result verbatim — the value the boundary must strip is
 * not a field of the record that crosses it.
 *
 * Validation order: envelope shape (`patch-syntax`), file-rev CAS
 * (`file-rev-mismatch`), per-line anchors with optional reapply
 * relocation (`hash-mismatch` / `ambiguous-reapply`), then splice
 * composition conflicts (`patch-syntax`).
 *
 * Same-line composition: operations anchored on the same line
 * compose as insert-before payloads, then the consumed line's
 * replacement (or the original line, or nothing for a delete), then
 * insert-after payloads — realizing the design's fixed
 * insert-after / insert-before / replace-or-delete priority as one
 * deterministic splice per line. Two ops that both consume a line
 * (two replaces, overlapping ranges) and inserts anchored on any
 * line of a consumed multi-line range (start and end boundary
 * included) are `patch-syntax` failures.
 *
 * On success, any anchor the bounded reapply search moved off its
 * authored line is reported in `result.relocations`, so a caller
 * can distinguish an edit that landed where it meant from one whose
 * (possibly colliding) anchor was relocated.
 *
 * @param {string} fileText
 * @param {unknown} patchValue a `HashlineEditPatch` envelope; re-validated
 *   here regardless of provenance
 * @param {Sha256HexFn} sha256Hex injected digest power (bytes to 64-char
 *   lowercase hex); a separate parameter, never an `options` member
 * @param {HashlineApplyEditOptions} [options] guest-tunable knobs only
 * @returns {HashlineSpliceOutcome}
 */
export const applyEditPatch = (
  fileText,
  patchValue,
  sha256Hex,
  options = {},
) => {
  // `sha256Hex` is the mount-supplied power, not a guest input: its absence is a
  // caller wiring error, so it throws rather than degrading to a structured
  // failure.
  if (typeof sha256Hex !== 'function') {
    throw makeError(X`applyEditPatch: sha256Hex power is required`);
  }

  // Shape-check the injected power's output at the same seam its presence is
  // checked. The whole-file CAS is the sole gate before anchor validation, so a
  // stubbed or mis-injected power returning a constant (or a non-hex string)
  // would make the CAS vacuously pass; requiring 64-char lowercase hex closes
  // that. `patch.expectedFileHash` is validated to the same shape, so the CAS
  // compares like against like.
  const digestOf = /** @param {string} text */ text => {
    const digest = sha256Hex(bytesFromText(text));
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw makeError(
        X`applyEditPatch: sha256Hex power must return 64-char lowercase hex, got ${q(digest)}`,
      );
    }
    return digest;
  };

  const fileHashActual = digestOf(fileText);

  // `options` is the guest-tunable partition (as against the mount-supplied
  // `sha256Hex` power), so every malformation of it degrades to a structured
  // `patch-syntax` failure rather than escaping as a raw engine throw — the same
  // contract the patch body itself is held to. A non-object (`null` included),
  // and a hostile accessor that throws while destructuring, are caught here; a
  // present-but-wrong `reapply`/`reapplyWindow` is reported below. Only
  // `undefined` takes the empty-object default (the parameter default fires on
  // `undefined` alone, so a `null` reaches this guard rather than destructuring
  // to a raw `TypeError`).
  /** @type {boolean} */
  let reapply;
  /** @type {number} */
  let reapplyWindow;
  try {
    if (typeof options !== 'object' || options === null) {
      throw makeError(
        X`applyEditPatch: options must be an object, got ${q(options)}`,
      );
    }
    ({ reapply = false, reapplyWindow = REAPPLY_WINDOW_DEFAULT } = options);
  } catch (error) {
    return failureOutcome(fileHashActual, 'patch-syntax', errorMessage(error));
  }
  if (typeof reapply !== 'boolean') {
    return failureOutcome(
      fileHashActual,
      'patch-syntax',
      `options.reapply must be a boolean, got ${typeof reapply}`,
    );
  }
  if (
    !Number.isInteger(reapplyWindow) ||
    reapplyWindow < 1 ||
    reapplyWindow > REAPPLY_WINDOW_MAX
  ) {
    return failureOutcome(
      fileHashActual,
      'patch-syntax',
      `options.reapplyWindow must be an integer in [1, ${REAPPLY_WINDOW_MAX}], got ${reapplyWindow}`,
    );
  }

  /** @type {HashlineEditPatch} */
  let patch;
  try {
    patch = validateEditPatch(patchValue);
  } catch (error) {
    return failureOutcome(fileHashActual, 'patch-syntax', errorMessage(error));
  }

  if (patch.expectedFileHash !== fileHashActual) {
    return failureOutcome(
      fileHashActual,
      'file-rev-mismatch',
      'the file changed since it was read; re-read at the current revision',
    );
  }

  const { lines, trailingNewline } = splitLines(fileText);
  const fileWidth = anchorHexWidthForLineCount(lines.length);

  // Memoize each live line's anchor hash per `(lineNumber, width)`. The strict
  // check, the mismatch report, and the reapply search all re-hash the same
  // window lines; without memoization the reapply scan re-hashes every
  // candidate once per anchor (`ops * 2 anchors * (2*window+1)` full-line
  // CRC32s), which turned the `MAX_EDIT_OPS` cap into minutes of synchronous
  // CPU inside the mount's critical section rather than the bound its comment
  // claims. There are at most two widths (2 and 4) and `lines.length` lines, so
  // this caps the work at `2 * lines.length` line hashings regardless of op
  // count.
  /** @type {Map<string, string>} keyed `${lineNumber}:${width}` */
  const liveAnchorHashMemo = new Map();
  /**
   * @param {number} lineNumber 1-indexed, must be within `lines`
   * @param {2 | 4} width
   * @returns {string}
   */
  const liveAnchorHash = (lineNumber, width) => {
    const key = `${lineNumber}:${width}`;
    let hash = liveAnchorHashMemo.get(key);
    if (hash === undefined) {
      hash = lineAnchorHash(lines[lineNumber - 1], lineNumber, width);
      liveAnchorHashMemo.set(key, hash);
    }
    return hash;
  };

  /**
   * The anchor's declared hex width. `validateAnchor` accepts a hash of
   * exactly 2 or 4 lowercase-hex chars, so the length is always 2 or 4; the
   * cast documents that invariant rather than re-checking it at runtime.
   *
   * @param {HashlineAnchor} anchor
   * @returns {2 | 4}
   */
  const anchorWidth = anchor => /** @type {2 | 4} */ (anchor.hash.length);

  /**
   * @param {HashlineAnchor} anchor
   * @returns {boolean} whether the anchor matches the live line
   */
  const anchorMatches = anchor =>
    anchor.line <= lines.length &&
    liveAnchorHash(anchor.line, anchorWidth(anchor)) === anchor.hash;

  /** @type {HashlineAnchorMismatch[]} */
  const mismatches = [];
  /** @type {HashlineReapplyAmbiguity[]} */
  const ambiguities = [];
  /** @type {Map<HashlineAnchor, number>} relocated anchor -> new line */
  const relocations = new Map();

  /** @param {HashlineAnchor} anchor */
  const recordMismatch = anchor => {
    const exists = anchor.line <= lines.length;
    mismatches.push(
      harden({
        line: anchor.line,
        hashExpected: anchor.hash,
        hashActualAtPatchWidth: exists
          ? liveAnchorHash(anchor.line, anchorWidth(anchor))
          : '',
        hashActualAtFileWidth: exists
          ? liveAnchorHash(anchor.line, fileWidth)
          : '',
      }),
    );
  };

  /**
   * Whether `anchor` is a blank-line anchor: its hash equals the blank-line
   * seed (`\n${line}`) for its authored line. A blank line's seed encodes its
   * position, so a genuinely-moved blank line can never match its own anchor at
   * a new line except by hash collision — and a blank anchor that reached the
   * relocation search would therefore only ever "match" an unrelated line by
   * that collision, silently splicing there. Blank anchors are position-bound
   * by construction, so they do not relocate. (A content line whose hash
   * happens to equal the blank seed is vanishingly rare and would only cause a
   * refusal to relocate — the safe direction.)
   *
   * @param {HashlineAnchor} anchor
   */
  const isBlankAnchor = anchor =>
    anchor.hash === lineAnchorHash('', anchor.line, anchorWidth(anchor));

  /**
   * Bounded relocation search per the design: visit the window in
   * nearest-by-distance order, lower line number first on ties,
   * collect every candidate whose hash matches at the anchor's
   * declared width.
   *
   * @param {HashlineAnchor} anchor
   */
  const searchReapply = anchor => {
    // Relocation on an 8-bit (2-char) anchor match alone is a 1/256-per-line
    // coin flip: across a +/-window a drifted narrow anchor finds a spurious
    // unique match often enough (~14% at the default window) to silently
    // splice onto an unrelated line. Require a 4-char (16-bit) anchor to
    // relocate; a narrow anchor that does not match strictly is a plain
    // `hash-mismatch`, even under reapply. A caller that wants relocation on a
    // small file authors 4-char anchors, which `validateAnchor` accepts at any
    // file size.
    if (anchor.hash.length < 4 || isBlankAnchor(anchor)) {
      recordMismatch(anchor);
      return;
    }
    /** @type {number[]} */
    const candidates = [];
    for (let distance = 0; distance <= reapplyWindow; distance += 1) {
      for (const candidateLine of distance === 0
        ? [anchor.line]
        : [anchor.line - distance, anchor.line + distance]) {
        if (candidateLine >= 1 && candidateLine <= lines.length) {
          const actual = liveAnchorHash(candidateLine, anchorWidth(anchor));
          if (actual === anchor.hash) {
            candidates.push(candidateLine);
          }
        }
      }
    }
    if (candidates.length === 1) {
      relocations.set(anchor, candidates[0]);
    } else if (candidates.length > 1) {
      ambiguities.push(
        harden({ line: anchor.line, candidates: harden(candidates) }),
      );
    } else {
      recordMismatch(anchor);
    }
  };

  for (const op of patch.ops) {
    for (const anchor of opAnchors(op)) {
      if (!anchorMatches(anchor)) {
        if (reapply) {
          searchReapply(anchor);
        } else {
          recordMismatch(anchor);
        }
      }
    }
  }

  if (ambiguities.length > 0) {
    // A single patch can carry both an ambiguous anchor (multiple
    // candidates) and a genuinely-unlocatable one (zero candidates,
    // recorded as a mismatch). Report the ambiguities as the reason but
    // carry any coexisting mismatches too, so the caller sees the
    // zero-candidate anchor's total relocation failure rather than
    // having it silently dropped.
    return failureOutcome(
      fileHashActual,
      'ambiguous-reapply',
      'multiple candidate lines match a relocated anchor',
      {
        ambiguities: harden(ambiguities),
        ...(mismatches.length > 0 && { mismatches: harden(mismatches) }),
      },
    );
  }
  if (mismatches.length > 0) {
    return failureOutcome(
      fileHashActual,
      'hash-mismatch',
      'one or more line anchors do not match the live file',
      { mismatches: harden(mismatches) },
    );
  }

  /**
   * The anchor a relocation moved this one to, or the anchor unchanged.
   * @param {HashlineAnchor} anchor
   * @returns {HashlineAnchor}
   */
  const relocatedAnchor = anchor => {
    const to = relocations.get(anchor);
    return to === undefined ? anchor : harden({ line: to, hash: anchor.hash });
  };

  // Ops with relocated anchor lines applied. Rebuilt per kind so each new op
  // matches its own `HashlineEditOp` union member (and preserves `payload` where the
  // kind carries it) without casting.
  /** @type {HashlineEditOp[]} */
  const ops = patch.ops.map(op => {
    switch (op.op) {
      case 'prepend':
      case 'append':
        return op;
      case 'replace':
      case 'insert-after':
      case 'insert-before': {
        const anchor = relocatedAnchor(op.anchor);
        return anchor === op.anchor
          ? op
          : harden({ op: op.op, anchor, payload: op.payload });
      }
      case 'delete': {
        const anchor = relocatedAnchor(op.anchor);
        const anchorEnd =
          op.anchorEnd === undefined
            ? undefined
            : relocatedAnchor(op.anchorEnd);
        return anchor === op.anchor && anchorEnd === op.anchorEnd
          ? op
          : harden({
              op: op.op,
              anchor,
              ...(anchorEnd === undefined ? {} : { anchorEnd }),
            });
      }
      case 'replace-range': {
        const anchor = relocatedAnchor(op.anchor);
        const anchorEnd = relocatedAnchor(op.anchorEnd);
        return anchor === op.anchor && anchorEnd === op.anchorEnd
          ? op
          : harden({ op: op.op, anchor, anchorEnd, payload: op.payload });
      }
      default:
        return op;
    }
  });

  // A relocation must MOVE an operation, never RESIZE it. The bounded search
  // relocates each endpoint of a range independently, so an unguarded search
  // could drift one endpoint while the other holds (or drift them by unequal
  // amounts), silently growing or shrinking the consumed span and
  // deleting/replacing lines the patch never named. Require both endpoints of
  // a range op to relocate by the same delta (which includes "neither moved");
  // equal deltas preserve span length and ordering, so this also subsumes the
  // inverted-range case.
  for (const op of patch.ops) {
    // Only `delete` and `replace-range` carry two endpoints; a `delete` may
    // carry just one.
    if (op.op === 'delete' || op.op === 'replace-range') {
      const { anchor, anchorEnd } = op;
      if (anchorEnd !== undefined) {
        const startTo = relocations.get(anchor);
        const endTo = relocations.get(anchorEnd);
        const startDelta =
          (startTo === undefined ? anchor.line : startTo) - anchor.line;
        const endDelta =
          (endTo === undefined ? anchorEnd.line : endTo) - anchorEnd.line;
        if (startDelta !== endDelta) {
          return failureOutcome(
            fileHashActual,
            'patch-syntax',
            `range op endpoints relocated by unequal deltas (${anchor.line}->${anchor.line + startDelta}, ${anchorEnd.line}->${anchorEnd.line + endDelta}); a relocation may move a range, not resize it`,
          );
        }
      }
    }
  }

  // Composition conflict checks: no two ops may consume the same
  // line, and no anchored insert may target any line of another op's
  // consumed multi-line range (anchoring on a consumed single line
  // composes; anchoring anywhere in a multi-line range is ambiguous).
  /** @type {Map<number, HashlineEditOp>} line -> consuming op */
  const consumedBy = new Map();
  for (const op of ops) {
    const span = consumedSpan(op);
    if (span !== undefined) {
      for (let line = span.start; line <= span.end; line += 1) {
        if (consumedBy.has(line)) {
          return failureOutcome(
            fileHashActual,
            'patch-syntax',
            `two operations both consume line ${line}`,
          );
        }
        consumedBy.set(line, op);
      }
    }
  }
  for (const op of ops) {
    if (op.op === 'insert-after' || op.op === 'insert-before') {
      const { line } = op.anchor;
      const consumer = consumedBy.get(line);
      if (consumer !== undefined) {
        const span = consumedSpan(consumer);
        if (span !== undefined && span.start !== span.end) {
          return failureOutcome(
            fileHashActual,
            'patch-syntax',
            `insert anchored on line ${line}, which another operation consumes as part of the range ${span.start}..${span.end}`,
          );
        }
      }
    }
  }

  // Compose per-line splice actions. Each action covers an inclusive
  // original-line span and yields replacement lines.
  /**
   * A splice over an inclusive original-line span, always `start <=
   * end`: single-line groups (any mix of inserts around, and an
   * optional replace/delete of, one line) use `start === end`;
   * multi-line range ops use the range's own bounds. Pure inserts are
   * folded into their anchor line's group rather than emitted as a
   * zero-span action.
   *
   * @typedef {object} SpliceAction
   * @property {number} start 1-indexed first line of the consumed span
   * @property {number} end 1-indexed last line of the consumed span
   * @property {string[]} content replacement lines for the span
   */

  /** @type {Map<number, { before: string[], after: string[], consume: HashlineEditOp | undefined }>} */
  const lineGroups = new Map();
  /** @type {{ span: { start: number, end: number }, op: HashlineEditOp }[]} */
  const rangeOps = [];
  /** @type {string[]} */
  const prependPayload = [];
  /** @type {string[]} */
  const appendPayload = [];

  const groupAt = (/** @type {number} */ line) => {
    let group = lineGroups.get(line);
    if (group === undefined) {
      group = { before: [], after: [], consume: undefined };
      lineGroups.set(line, group);
    }
    return group;
  };

  for (const op of ops) {
    if (op.op === 'prepend') {
      appendAll(prependPayload, op.payload);
    } else if (op.op === 'append') {
      appendAll(appendPayload, op.payload);
    } else if (op.op === 'insert-before') {
      appendAll(groupAt(op.anchor.line).before, op.payload);
    } else if (op.op === 'insert-after') {
      appendAll(groupAt(op.anchor.line).after, op.payload);
    } else {
      const span = consumedSpan(op);
      if (span !== undefined) {
        if (span.start === span.end) {
          groupAt(span.start).consume = op;
        } else {
          rangeOps.push({ span, op });
        }
      }
    }
  }

  /** @type {SpliceAction[]} */
  const actions = [];
  for (const [line, group] of lineGroups) {
    /** @type {string[]} */
    const content = [];
    appendAll(content, group.before);
    if (group.consume === undefined) {
      content.push(lines[line - 1]);
    } else if (group.consume.op !== 'delete') {
      appendAll(content, group.consume.payload);
    }
    appendAll(content, group.after);
    actions.push({ start: line, end: line, content });
  }
  for (const { span, op } of rangeOps) {
    /** @type {string[]} */
    const content = [];
    if (op.op !== 'delete') {
      appendAll(content, op.payload);
    }
    actions.push({ start: span.start, end: span.end, content });
  }

  // Actions are non-overlapping spans (the composition checks above forbid two
  // ops consuming the same line and inserts landing inside a range), so the
  // result is built by walking the original lines in order and substituting
  // each action's content for its span. Appending element-by-element rather
  // than spreading payload arrays into `push`/`splice`/`unshift` keeps a
  // caller-controlled payload length from becoming an argument-count
  // `RangeError` (which escapes the structured-failure contract and is
  // engine-dependent — it trips far sooner under XS's slot-budgeted stack).
  actions.sort((a, b) => a.start - b.start);

  /** @type {string[]} */
  const result = [];
  appendAll(result, prependPayload);
  let cursor = 1; // 1-indexed next original line to emit
  for (const action of actions) {
    for (let line = cursor; line < action.start; line += 1) {
      result.push(lines[line - 1]);
    }
    appendAll(result, action.content);
    cursor = action.end + 1;
  }
  for (let line = cursor; line <= lines.length; line += 1) {
    result.push(lines[line - 1]);
  }
  appendAll(result, appendPayload);

  // Bound the result before `joinLines` builds it into one string: a total
  // past the engine's max string length would throw a raw `RangeError` out of
  // the structured-failure contract. Summed here (not on `newText.length`,
  // which is too late) plus the interior newline count `joinLines` adds.
  let resultChars = result.length === 0 ? 0 : result.length - 1;
  for (let index = 0; index < result.length; index += 1) {
    resultChars += result[index].length;
    if (resultChars > MAX_RESULT_CHARS) {
      return failureOutcome(
        fileHashActual,
        'patch-syntax',
        `spliced result exceeds the ${MAX_RESULT_CHARS}-character limit; the mount bounds total payload volume`,
      );
    }
  }

  const newText = joinLines(result, trailingNewline);
  const fileHashAfter = digestOf(newText);
  // Surface any reapply relocations so a caller can distinguish an
  // edit that landed on its authored line from one whose anchor was
  // moved (`searchReapply` refuses to relocate anchors narrower than
  // 4 chars, so a relocated anchor collided at the 16-bit level).
  const relocationReport = [...relocations]
    .map(([anchor, relocatedTo]) => harden({ line: anchor.line, relocatedTo }))
    .sort((a, b) => a.relocatedTo - b.relocatedTo);
  // The boundary-safe `result` carries no file text; `newText` rides the
  // separate channel a mount writes but must not forward.
  return harden({
    result: harden({
      success: true,
      fileHashAfter,
      ...(relocationReport.length === 0
        ? {}
        : { relocations: harden(relocationReport) }),
    }),
    newText,
  });
};
harden(applyEditPatch);
