// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { encodeUtf8 } from '@endo/utf8/encode.js';
import { encodeHex } from '@endo/hex';
import { sha256 } from '@endo/sha256';

import {
  EMPTY_FILE_SHA256,
  anchorHexWidthForLineCount,
  applyEditPatch,
  joinLines,
  lineAnchorHash,
  parseHashlineText,
  renderHashlineLines,
  splitLines,
  validateEditPatch,
} from '../src/hashline.js';

/** @import { HashlineEditResult, HashlineEditFailure } from '../src/types.js' */

/** @param {Uint8Array} bytes */
const sha256Hex = bytes => encodeHex(sha256(bytes));

/** @param {string} text */
const hashOfText = text => sha256Hex(encodeUtf8(text));

/**
 * A patch envelope against `text` with anchors computed from the live
 * file, so tests express edits by line number and content only.
 *
 * @param {string} text
 * @param {Array<Record<string, unknown>>} ops with `line` /
 *   `lineEnd` shorthand instead of anchors
 */
const patchFor = (text, ops) => {
  const { lines } = splitLines(text);
  const width = anchorHexWidthForLineCount(lines.length);
  /** @param {number} line */
  const anchorAt = line => ({
    line,
    hash: lineAnchorHash(lines[line - 1], line, width),
  });
  return {
    expectedFileHash: hashOfText(text),
    ops: ops.map(({ line, lineEnd, ...rest }) => ({
      ...rest,
      ...(line === undefined ? {} : { anchor: anchorAt(Number(line)) }),
      ...(lineEnd === undefined
        ? {}
        : { anchorEnd: anchorAt(Number(lineEnd)) }),
    })),
  };
};

/**
 * The failure record off a failed `HashlineEditResult`. `HashlineEditResult` is a
 * discriminated union on `success`, so the failure member is read through a
 * shape that admits its optional presence rather than off the raw union.
 *
 * @param {HashlineEditResult} result
 * @returns {HashlineEditFailure}
 */
const failureOf = result =>
  /** @type {HashlineEditFailure} */ (
    /** @type {{ failure?: HashlineEditFailure }} */ (result).failure
  );

test('lineAnchorHash widths and normalization', t => {
  const h2 = lineAnchorHash('const x = 1;', 7, 2);
  t.regex(h2, /^[0-9a-f]{2}$/);
  const h4 = lineAnchorHash('const x = 1;', 7, 4);
  t.regex(h4, /^[0-9a-f]{4}$/);
  // The 2-char hash is the low byte of the 4-char hash.
  t.is(h4.slice(2), h2);
  // Trailing whitespace and a trailing CR do not change the hash.
  t.is(lineAnchorHash('const x = 1;  \t', 7), h2);
  t.is(lineAnchorHash('const x = 1;\r', 7), h2);
  // Leading whitespace does.
  t.not(lineAnchorHash('  const x = 1;', 7), h2);
});

test('anchor hashing strips exactly the wire-contract whitespace set, no wider', t => {
  // normalizeLineForHash strips exactly U+0020 SPACE, U+0009 TAB, U+000D CR —
  // the wire contract. Every OTHER trailing whitespace code point that
  // `String.prototype.trimEnd` (or a `/\s+$/` regex) would remove must CHANGE
  // the anchor, or an independent implementer reaching for `.trimEnd` would
  // silently agree here and diverge on the wire. Only the positive half was
  // pinned; a `.trimEnd`-based rewrite passes it while breaking the contract.
  const base = 'const x = 1;';
  const h = lineAnchorHash(base, 7);
  for (const trailing of ['\u00a0', '\u000b', '\u000c', '\u2028', '\ufeff']) {
    t.not(
      lineAnchorHash(base + trailing, 7),
      h,
      `trailing U+${trailing.charCodeAt(0).toString(16).padStart(4, '0')} must change the anchor`,
    );
  }
  // Sanity: the three in-contract code points (and their combinations) still do
  // NOT change it.
  for (const trailing of [' ', '\t', '\r', '  \t\r']) {
    t.is(lineAnchorHash(base + trailing, 7), h);
  }
});

test('blank lines are seeded with their line number', t => {
  t.not(lineAnchorHash('', 3), lineAnchorHash('', 4));
  t.is(lineAnchorHash('   ', 3), lineAnchorHash('', 3));
});

test('anchorHexWidthForLineCount crosses at 4096 lines', t => {
  t.is(anchorHexWidthForLineCount(0), 2);
  t.is(anchorHexWidthForLineCount(4096), 2);
  t.is(anchorHexWidthForLineCount(4097), 4);
});

// --- splitLines / joinLines ---

test('splitLines and joinLines round-trip', t => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\n', '\n', 'a\n\nb\n']) {
    const { lines, trailingNewline } = splitLines(text);
    t.is(joinLines([...lines], trailingNewline), text, JSON.stringify(text));
  }
});

test('splitLines treats the empty file as trailing-newline-true', t => {
  t.deepEqual(splitLines(''), { lines: [], trailingNewline: true });
});

test('splitLines keeps CR on the line content', t => {
  t.deepEqual(splitLines('a\r\nb\n').lines, ['a\r', 'b']);
});

// --- renderHashlineLines ---

test('renderHashlineLines annotates each line', t => {
  const text = '# Today\n\nBuy milk.\n';
  const rendered = renderHashlineLines(text);
  t.deepEqual(rendered, [
    `1#${lineAnchorHash('# Today', 1)} # Today`,
    `2#${lineAnchorHash('', 2)}`,
    `3#${lineAnchorHash('Buy milk.', 3)} Buy milk.`,
  ]);
});

test('renderHashlineLines right-aligns line numbers', t => {
  const text = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const rendered = renderHashlineLines(text);
  t.true(rendered[0].startsWith(' 1#'));
  t.true(rendered[9].startsWith('10#'));
});

// --- validateEditPatch ---

test('validateEditPatch accepts a well-formed envelope', t => {
  const patch = validateEditPatch({
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: [{ op: 'append', payload: ['hello'] }],
  });
  t.is(patch.ops.length, 1);
});

test('validateEditPatch rejects malformed envelopes', t => {
  const base = { expectedFileHash: EMPTY_FILE_SHA256 };
  const cases = [
    // the envelope itself is not an object
    null,
    'nope',
    {},
    { expectedFileHash: 'nope', ops: [] },
    // ops is not an array
    { ...base, ops: 'nope' },
    // an op is not an object
    { ...base, ops: [null] },
    { ...base, ops: ['append'] },
    // a payload entry is not a string
    { ...base, ops: [{ op: 'append', payload: [42] }] },
    { ...base, ops: [{ op: 'frobnicate' }] },
    // replace requires anchor and payload
    { ...base, ops: [{ op: 'replace', payload: ['x'] }] },
    { ...base, ops: [{ op: 'replace', anchor: { line: 1, hash: 'ab' } }] },
    // delete must not carry payload
    {
      ...base,
      ops: [{ op: 'delete', anchor: { line: 1, hash: 'ab' }, payload: ['x'] }],
    },
    // prepend must not carry anchor
    {
      ...base,
      ops: [{ op: 'prepend', anchor: { line: 1, hash: 'ab' }, payload: ['x'] }],
    },
    // replace-range requires anchorEnd
    {
      ...base,
      ops: [
        { op: 'replace-range', anchor: { line: 1, hash: 'ab' }, payload: [] },
      ],
    },
    // replace must not carry anchorEnd
    {
      ...base,
      ops: [
        {
          op: 'replace',
          anchor: { line: 1, hash: 'ab' },
          anchorEnd: { line: 2, hash: 'cd' },
          payload: ['x'],
        },
      ],
    },
    // inverted range
    {
      ...base,
      ops: [
        {
          op: 'delete',
          anchor: { line: 5, hash: 'ab' },
          anchorEnd: { line: 2, hash: 'cd' },
        },
      ],
    },
    // embedded newline in payload
    { ...base, ops: [{ op: 'append', payload: ['a\nb'] }] },
    // bad anchor shapes
    { ...base, ops: [{ op: 'delete', anchor: { line: 0, hash: 'ab' } }] },
    { ...base, ops: [{ op: 'delete', anchor: { line: 1, hash: 'xyz' } }] },
    { ...base, ops: [{ op: 'delete', anchor: { line: 1, hash: 'abcde' } }] },
    // valid hex but off-contract 3-char width: the wire contract fixes
    // exactly 2-char (<=4096 lines) or 4-char (>4096) anchors, never 3.
    { ...base, ops: [{ op: 'delete', anchor: { line: 1, hash: 'abc' } }] },
  ];
  for (const [index, envelope] of cases.entries()) {
    t.throws(() => validateEditPatch(envelope), undefined, `case ${index}`);
  }
});

// --- validateEditPatch: hostile-input hardening ---

test('an anchor getter cannot smuggle a value past validateAnchor', t => {
  // A getter that passes the guard on early reads and turns hostile on a later
  // read must not land a value that the guard never saw in the hardened patch.
  let lineReads = 0;
  const envelope = {
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: [
      {
        op: 'delete',
        anchor: {
          get line() {
            lineReads += 1;
            return lineReads === 1 ? 3 : -5;
          },
          hash: 'ab',
        },
      },
    ],
  };
  const patch = validateEditPatch(envelope);
  const { anchor } = /** @type {any} */ (patch.ops[0]);
  // The snapshot is a plain positive integer, not the getter's later -5.
  t.is(anchor.line, 3);
});

test('an expectedFileHash getter cannot smuggle a non-hex value', t => {
  let reads = 0;
  const envelope = {
    get expectedFileHash() {
      reads += 1;
      return reads === 1 ? EMPTY_FILE_SHA256 : 'NOT-A-HASH';
    },
    ops: [],
  };
  const patch = validateEditPatch(envelope);
  t.is(patch.expectedFileHash, EMPTY_FILE_SHA256);
});

test('a proxy ops array with a map trap cannot bypass validateEditOp', t => {
  // `Array.isArray` is true for a proxy over an array, so validation must map
  // through the intrinsic, not the proxy's own `map`. The trap here would
  // otherwise inject an op carrying an embedded-newline payload that no
  // per-op guard ever saw.
  const ops = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'map') {
        return () => [{ op: 'append', payload: ['a\nb'] }];
      }
      return Reflect.get(target, property, receiver);
    },
  });
  // The intrinsic map sees an empty array, so this validates as a no-op patch
  // rather than admitting the trapped op.
  const patch = validateEditPatch({
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: /** @type {any} */ (ops),
  });
  t.is(patch.ops.length, 0);
});

test('a proxy payload array with a map trap cannot bypass the payload guard', t => {
  const payload = new Proxy(['ok'], {
    get(target, property, receiver) {
      if (property === 'map') {
        return () => ['a\nb'];
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const patch = validateEditPatch({
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: [{ op: 'append', payload: /** @type {any} */ (payload) }],
  });
  t.deepEqual(/** @type {any} */ (patch.ops[0]).payload, ['ok']);
});

test('validateEditPatch caps the operation count', t => {
  const ops = Array.from({ length: 10_001 }, () => ({
    op: 'append',
    payload: ['x'],
  }));
  t.throws(
    () => validateEditPatch({ expectedFileHash: EMPTY_FILE_SHA256, ops }),
    { message: /at most 10000 operations/ },
  );
});

test('a proxy ops array reporting a hostile length cannot drop every op as a silent success', t => {
  // `Array.isArray` is true for a proxy-over-array, and array `length` is
  // writable, so a `get` trap can report `NaN` (or `-1`/`undefined`) as
  // `ops.length`. A bare `> MAX_EDIT_OPS` comparison is false for `NaN`, so
  // without the safe-integer guard the validation loop's `index < count` is
  // vacuously false: the patch validates to an EMPTY `ops` list and
  // `applyEditPatch` reports `success: true` for a patch whose every operation
  // was silently dropped — the caller is told an edit landed that never applied.
  for (const hostileLength of [Number.NaN, -1, undefined, 1.5]) {
    const realOps = [{ op: 'append', payload: ['x'] }];
    const ops = new Proxy(realOps, {
      get(target, property, receiver) {
        if (property === 'length') {
          return hostileLength;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    t.throws(
      () =>
        validateEditPatch({
          expectedFileHash: EMPTY_FILE_SHA256,
          ops: /** @type {any} */ (ops),
        }),
      { message: /at most 10000 operations/ },
      `ops.length ${String(hostileLength)} must be rejected`,
    );
    // The same hostile length through the public applyEditPatch seam degrades to
    // a structured patch-syntax failure, never a silent success with the file
    // unchanged.
    const text = 'alpha\nbravo\ncharlie\n';
    const outcome = applyEditPatch(
      text,
      { expectedFileHash: hashOfText(text), ops: /** @type {any} */ (ops) },
      sha256Hex,
    );
    t.false(outcome.result.success);
    t.is(failureOf(outcome.result).reason, 'patch-syntax');
  }
});

test('a proxy payload declaring a hostile length fails patch-syntax without spinning the loop', t => {
  // The payload guard must be load-bearing: `Array.isArray` is true for a
  // proxy-over-array and array `length` is writable, so a ~50-byte proxy can
  // declare an enormous `length` and answer every index. Without the
  // safe-integer + cap guard, `validateElements` materializes billions of
  // references inside the mount's synchronous critical section before
  // `MAX_RESULT_CHARS` (which guards the downstream join, not this allocation)
  // could fire. The guard rejects it before the loop, so this returns promptly
  // rather than timing out.
  t.timeout(30_000);
  const hugePayload = new Proxy(['x'], {
    get(target, property, receiver) {
      if (property === 'length') {
        return 2 ** 31;
      }
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        return 'x';
      }
      return Reflect.get(target, property, receiver);
    },
  });
  t.throws(
    () =>
      validateEditPatch({
        expectedFileHash: EMPTY_FILE_SHA256,
        ops: [{ op: 'append', payload: /** @type {any} */ (hugePayload) }],
      }),
    { message: /payload must hold at most/ },
  );
  // A `NaN`/non-integer payload length is the silent-empty-payload hole: without
  // the safe-integer half of the guard, `validateElements` runs zero iterations
  // and the op validates with an empty payload rather than failing.
  const nanPayload = new Proxy(['x'], {
    get(target, property, receiver) {
      if (property === 'length') {
        return Number.NaN;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  t.throws(
    () =>
      validateEditPatch({
        expectedFileHash: EMPTY_FILE_SHA256,
        ops: [{ op: 'append', payload: /** @type {any} */ (nanPayload) }],
      }),
    { message: /payload must hold at most/ },
  );
});

// --- parseHashlineText ---

test('parseHashlineText parses a full patch', t => {
  const hash = EMPTY_FILE_SHA256;
  const patch = parseHashlineText(
    [
      '# a leading comment',
      `@expected-file-hash ${hash}`,
      '@replace 4#7e',
      '| Buy eggs (the brown ones).',
      '',
      '@insert-after 4#7e',
      '| Buy bread.',
      '|',
      '',
      '@delete 12#aa..14#bc',
      '',
      '@replace 6#0a..7#0b',
      '| merged',
      '',
      '@prepend',
      '| #!/usr/bin/env node',
      '',
      '@append',
      '| EOF',
    ].join('\n'),
  );
  t.is(patch.expectedFileHash, hash);
  t.deepEqual(
    patch.ops.map(op => op.op),
    ['replace', 'insert-after', 'delete', 'replace-range', 'prepend', 'append'],
  );
  // The empty payload line (`|`) survives as an empty string.
  t.deepEqual(/** @type {any} */ (patch.ops[1]).payload, ['Buy bread.', '']);
  t.deepEqual(/** @type {any} */ (patch.ops[2]).anchor, {
    line: 12,
    hash: 'aa',
  });
  t.deepEqual(/** @type {any} */ (patch.ops[2]).anchorEnd, {
    line: 14,
    hash: 'bc',
  });
});

test('parseHashlineText rejects syntax errors', t => {
  const hash = EMPTY_FILE_SHA256;
  const cases = [
    // missing @expected-file-hash header
    '@append\n| x',
    // malformed header hash
    '@expected-file-hash zzz\n@append\n| x',
    // unknown op
    `@expected-file-hash ${hash}\n@frobnicate 1#ab`,
    // malformed anchor
    `@expected-file-hash ${hash}\n@replace 1#zz\n| x`,
    // valid hex but off-contract 3-char anchor width
    `@expected-file-hash ${hash}\n@replace 1#abc\n| x`,
    // anchor on prepend
    `@expected-file-hash ${hash}\n@prepend 1#ab\n| x`,
    // missing anchor on replace
    `@expected-file-hash ${hash}\n@replace\n| x`,
    // payload outside any op
    `@expected-file-hash ${hash}\n| stray`,
    // free text
    `@expected-file-hash ${hash}\nnot a patch line`,
    // duplicate @expected-file-hash header: a top-down reader and the parser
    // must not derive different revisions from the same bytes.
    `@expected-file-hash ${hash}\n@expected-file-hash ${hash}\n@append\n| x`,
  ];
  for (const [index, text] of cases.entries()) {
    t.throws(() => parseHashlineText(text), undefined, `case ${index}`);
  }
});

test('parseHashlineText enforces the operation cap', t => {
  // The parser enforces `MAX_EDIT_OPS` in its own flush loop, not only in the
  // structured `validateEditPatch` reader — the two readers of one wire format
  // must agree on every limit. A patch of 10001 minimal `@delete` blocks throws
  // before it can return an over-cap patch.
  const header = `@expected-file-hash ${EMPTY_FILE_SHA256}\n\n`;
  const block = '@delete 1#00\n\n';
  const text = `${header}${block.repeat(10_001)}`;
  t.throws(() => parseHashlineText(text), { message: /too many operations/ });
});

// --- applyEditPatch: the worked example ---

test('applyEditPatch applies the design worked example', t => {
  const text = "# Today's notes\n\nBuy milk.\nBuy eggs.\n\n";
  const patch = patchFor(text, [
    { op: 'replace', line: 4, payload: ['Buy eggs (the brown ones).'] },
    { op: 'insert-after', line: 4, payload: ['Buy bread.'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(
    newText,
    "# Today's notes\n\nBuy milk.\nBuy eggs (the brown ones).\nBuy bread.\n\n",
  );
  t.is(result.fileHashAfter, hashOfText(/** @type {string} */ (newText)));
  // The whole-file result must never carry `newText`: keeping it off the
  // boundary-crossing `HashlineEditResult` is what makes a write-only `edit` guest
  // unable to read the file back through the result. A success `result` that
  // re-added it would leave every other test green (none read `result.newText`),
  // so pin the absence explicitly.
  t.is(/** @type {any} */ (result).newText, undefined);
  t.false('newText' in result);
});

// --- applyEditPatch: CAS and anchor validation ---

test('applyEditPatch fails file-rev-mismatch on a stale file hash', t => {
  const text = 'a\nb\n';
  const patch = patchFor(text, [{ op: 'delete', line: 1 }]);
  const changed = 'a\nb\nc\n';
  const { result, newText } = applyEditPatch(changed, patch, sha256Hex);
  t.false(result.success);
  t.is(newText, undefined);
  const failure = failureOf(result);
  t.is(failure.reason, 'file-rev-mismatch');
  t.is(failure.fileHashActual, hashOfText(changed));
  t.is(result.fileHashAfter, hashOfText(changed));
});

test('applyEditPatch fails hash-mismatch with both widths reported', t => {
  const text = 'alpha\nbeta\ngamma\n';
  const patch = {
    expectedFileHash: hashOfText(text),
    ops: [
      {
        op: 'replace',
        anchor: { line: 2, hash: '0000' },
        payload: ['BETA'],
      },
    ],
  };
  const { result } = applyEditPatch(text, patch, sha256Hex);
  t.false(result.success);
  const failure = failureOf(result);
  t.is(failure.reason, 'hash-mismatch');
  t.deepEqual(failure.mismatches, [
    {
      line: 2,
      hashExpected: '0000',
      hashActualAtPatchWidth: lineAnchorHash('beta', 2, 4),
      hashActualAtFileWidth: lineAnchorHash('beta', 2, 2),
    },
  ]);
});

test('applyEditPatch reports an out-of-range anchor as a mismatch', t => {
  const text = 'only\n';
  const patch = {
    expectedFileHash: hashOfText(text),
    ops: [{ op: 'delete', anchor: { line: 9, hash: 'ab' } }],
  };
  const { result } = applyEditPatch(text, patch, sha256Hex);
  t.false(result.success);
  const failure = failureOf(result);
  t.is(failure.reason, 'hash-mismatch');
  t.deepEqual(failure.mismatches, [
    {
      line: 9,
      hashExpected: 'ab',
      hashActualAtPatchWidth: '',
      hashActualAtFileWidth: '',
    },
  ]);
});

test('applyEditPatch returns patch-syntax on a malformed envelope', t => {
  const text = 'a\n';
  const { result } = applyEditPatch(text, { nope: true }, sha256Hex);
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
  t.is(result.fileHashAfter, hashOfText(text));
});

test('a hostile expectedFileHash getter throwing a non-Error yields a patch-syntax failure', t => {
  const text = 'a\nb\n';
  // A getter that throws `undefined` — so reading `.message` on the caught value
  // would itself be a raw TypeError — must still yield a structured failure and
  // not escape the contract with a raw throw.
  const throwsUndefined = {
    get expectedFileHash() {
      // eslint-disable-next-line no-throw-literal
      throw undefined;
    },
    ops: [],
  };
  const undefinedOutcome = applyEditPatch(text, throwsUndefined, sha256Hex);
  t.false(undefinedOutcome.result.success);
  t.is(failureOf(undefinedOutcome.result).reason, 'patch-syntax');
  // A getter that throws a non-Error primitive (42) still yields a structured
  // failure whose diagnostic message is a string.
  const throws42 = {
    get expectedFileHash() {
      // eslint-disable-next-line no-throw-literal
      throw 42;
    },
    ops: [],
  };
  const outcome42 = applyEditPatch(text, throws42, sha256Hex);
  t.false(outcome42.result.success);
  t.is(failureOf(outcome42.result).reason, 'patch-syntax');
  t.is(typeof failureOf(outcome42.result).message, 'string');
});

test('an Error-branded hostile message getter cannot escape applyEditPatch as a raw throw', t => {
  const text = 'a\nb\n';
  // `instanceof Error` only walks the prototype chain, so an object whose
  // prototype is `Error.prototype` and whose own `message` is a throwing getter
  // passes the brand; reading `.message` then throws. If that read sat outside
  // the coercion `try`, the guest-crafted throw would escape applyEditPatch as a
  // raw throw, carrying the guest's live object (with its live accessors) across
  // the mount boundary instead of a hardened failure record. It must degrade to
  // a structured patch-syntax failure with a string message.
  const hostile = Object.create(Error.prototype, {
    message: {
      get() {
        throw Error('boom from message getter');
      },
    },
  });
  const throwsHostile = {
    get expectedFileHash() {
      throw hostile;
    },
    ops: [],
  };
  const hostileOutcome = applyEditPatch(text, throwsHostile, sha256Hex);
  t.false(hostileOutcome.result.success);
  t.is(failureOf(hostileOutcome.result).reason, 'patch-syntax');
  t.is(typeof failureOf(hostileOutcome.result).message, 'string');

  // A genuine `Error` with a throwing own `message` accessor is the same hazard,
  // so no brand check can fix this — only reading inside the `try` does.
  const genuine = Error('ignored');
  Object.defineProperty(genuine, 'message', {
    get() {
      throw Error('boom');
    },
  });
  const throwsGenuine = {
    get expectedFileHash() {
      throw genuine;
    },
    ops: [],
  };
  const genuineOutcome = applyEditPatch(text, throwsGenuine, sha256Hex);
  t.false(genuineOutcome.result.success);
  t.is(failureOf(genuineOutcome.result).reason, 'patch-syntax');

  // A `message` getter that returns without throwing but yields a non-string
  // (an attacker-chosen object) must not land a non-string into the
  // string-typed `failure.message` field that crosses the boundary hardened.
  const nonStringMessage = Object.create(Error.prototype, {
    message: {
      get() {
        return { evil: true };
      },
    },
  });
  const throwsNonString = {
    get expectedFileHash() {
      throw nonStringMessage;
    },
    ops: [],
  };
  const nonStringOutcome = applyEditPatch(text, throwsNonString, sha256Hex);
  t.false(nonStringOutcome.result.success);
  t.is(failureOf(nonStringOutcome.result).reason, 'patch-syntax');
  t.is(typeof failureOf(nonStringOutcome.result).message, 'string');
});

test('applyEditPatch shape-checks the sha256Hex power output', t => {
  const text = 'a\n';
  const patch = patchFor(text, [{ op: 'append', payload: ['x'] }]);
  // A power returning a non-64-hex string is rejected (throws): the whole-file
  // CAS is the sole gate before anchor validation, so a stubbed or mis-injected
  // digest that returned a constant (or a non-hex string) would make the CAS
  // vacuously pass.
  t.throws(() => applyEditPatch(text, patch, () => 'not-a-valid-hash'));
});

test('a 2-char anchor still validates against a wide file', t => {
  const lineCount = 5000;
  const text = `${Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n')}\n`;
  t.is(anchorHexWidthForLineCount(lineCount), 4);
  const patch = {
    expectedFileHash: hashOfText(text),
    ops: [
      {
        op: 'replace',
        // A narrow anchor, as authored against an old 2-char render.
        anchor: { line: 3, hash: lineAnchorHash('line 2', 3, 2) },
        payload: ['LINE 2'],
      },
    ],
  };
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.true(/** @type {string} */ (newText).includes('LINE 2\nline 3'));
});

// --- applyEditPatch: splice semantics ---

test('same-line ops compose as before, replacement, after', t => {
  const text = 'one\ntwo\nthree\n';
  const patch = patchFor(text, [
    { op: 'insert-after', line: 2, payload: ['after'] },
    { op: 'replace', line: 2, payload: ['TWO'] },
    { op: 'insert-before', line: 2, payload: ['before'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'one\nbefore\nTWO\nafter\nthree\n');
});

test('inserts compose around a same-line delete', t => {
  const text = 'one\ntwo\nthree\n';
  const patch = patchFor(text, [
    { op: 'insert-before', line: 2, payload: ['before'] },
    { op: 'delete', line: 2 },
    { op: 'insert-after', line: 2, payload: ['after'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'one\nbefore\nafter\nthree\n');
});

test('multiple ops apply bottom-up against original coordinates', t => {
  const text = 'a\nb\nc\nd\ne\n';
  const patch = patchFor(text, [
    { op: 'delete', line: 1 },
    { op: 'replace', line: 3, payload: ['C', 'C2'] },
    { op: 'insert-after', line: 5, payload: ['f'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'b\nC\nC2\nd\ne\nf\n');
});

test('range replace and range delete', t => {
  const text = 'a\nb\nc\nd\ne\n';
  const { newText: replacedText } = applyEditPatch(
    text,
    patchFor(text, [
      { op: 'replace-range', line: 2, lineEnd: 4, payload: ['BCD'] },
    ]),
    sha256Hex,
  );
  t.is(replacedText, 'a\nBCD\ne\n');
  const { newText: deletedText } = applyEditPatch(
    text,
    patchFor(text, [{ op: 'delete', line: 2, lineEnd: 4 }]),
    sha256Hex,
  );
  t.is(deletedText, 'a\ne\n');
});

test('two ops consuming the same line fail patch-syntax', t => {
  const text = 'a\nb\nc\n';
  const patch = patchFor(text, [
    { op: 'replace', line: 2, payload: ['x'] },
    { op: 'delete', line: 1, lineEnd: 2 },
  ]);
  const { result } = applyEditPatch(text, patch, sha256Hex);
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
});

test('an insert anchored inside a consumed range fails patch-syntax', t => {
  const text = 'a\nb\nc\nd\n';
  const patch = patchFor(text, [
    { op: 'delete', line: 2, lineEnd: 3 },
    { op: 'insert-after', line: 3, payload: ['x'] },
  ]);
  const { result } = applyEditPatch(text, patch, sha256Hex);
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
});

test('prepend and append land first and last', t => {
  const text = 'middle\n';
  const patch = patchFor(text, [
    { op: 'insert-before', line: 1, payload: ['above middle'] },
    { op: 'insert-after', line: 1, payload: ['below middle'] },
    { op: 'prepend', payload: ['top'] },
    { op: 'append', payload: ['bottom'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'top\nabove middle\nmiddle\nbelow middle\nbottom\n');
});

test('multiple prepends and appends keep patch order', t => {
  const text = 'x\n';
  const patch = patchFor(text, [
    { op: 'prepend', payload: ['p1'] },
    { op: 'prepend', payload: ['p2'] },
    { op: 'append', payload: ['a1'] },
    { op: 'append', payload: ['a2'] },
  ]);
  const { newText } = applyEditPatch(text, patch, sha256Hex);
  t.is(newText, 'p1\np2\nx\na1\na2\n');
});

test('populating the empty file via append', t => {
  const patch = {
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: [{ op: 'append', payload: ['first line'] }],
  };
  const { result, newText } = applyEditPatch('', patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'first line\n');
});

test('CRLF content survives a splice on another line', t => {
  const text = 'a\r\nb\r\nc\r\n';
  const patch = patchFor(text, [{ op: 'replace', line: 2, payload: ['B'] }]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  // Untouched lines keep their CR; the new line is bare LF.
  t.is(newText, 'a\r\nB\nc\r\n');
});

test('a missing trailing newline is preserved', t => {
  const text = 'a\nb';
  const patch = patchFor(text, [{ op: 'replace', line: 1, payload: ['A'] }]);
  const { newText } = applyEditPatch(text, patch, sha256Hex);
  t.is(newText, 'A\nb');
});

test('deleting every line yields the empty file', t => {
  const text = 'a\nb\n';
  const patch = patchFor(text, [{ op: 'delete', line: 1, lineEnd: 2 }]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.is(newText, '');
  t.is(result.fileHashAfter, EMPTY_FILE_SHA256);
});

// --- reapply ---

test('reapply relocates a drifted anchor', t => {
  // The agent authored against 'a\nb\ntarget\nc\n', but two lines
  // were inserted above, and the file hash was refreshed (reapply
  // does not relax the CAS). A 4-char (16-bit) anchor is required to
  // relocate; an 8-bit anchor would relocate on a 1/256 coin flip, so
  // reapply refuses it.
  const drifted = 'x\ny\na\nb\ntarget\nc\n';
  const anchor = {
    line: 3,
    hash: lineAnchorHash('target', 3, 4),
  };
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [{ op: 'replace', anchor, payload: ['TARGET'] }],
  };
  const { result: strict } = applyEditPatch(drifted, patch, sha256Hex);
  t.false(strict.success);
  t.is(failureOf(strict).reason, 'hash-mismatch');
  const { result: relocated, newText: relocatedText } = applyEditPatch(
    drifted,
    patch,
    sha256Hex,
    { reapply: true },
  );
  t.true(relocated.success, JSON.stringify(failureOf(relocated)));
  t.is(relocatedText, 'x\ny\na\nb\nTARGET\nc\n');
  // The move (authored line 3 -> live line 5) is reported so a caller
  // can tell a clean landing from a relocated (possibly colliding) one.
  t.deepEqual(/** @type {any} */ (relocated).relocations, [
    { line: 3, relocatedTo: 5 },
  ]);
});

test('a successful edit with no relocation omits the relocations field', t => {
  const text = 'a\nb\nc\n';
  const patch = patchFor(text, [{ op: 'replace', line: 2, payload: ['B'] }]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex, {
    reapply: true,
  });
  t.true(result.success, JSON.stringify(failureOf(result)));
  t.is(newText, 'a\nB\nc\n');
  t.is(/** @type {any} */ (result).relocations, undefined);
});

test('reapply relocates both anchors of a range op', t => {
  // A `replace-range` authored against 'a\nb\nfoo\nbar\nc\n' where
  // two lines were inserted above, drifting both range anchors down
  // by two. Reapply must relocate anchor AND anchorEnd and rebuild
  // the range op (payload included).
  const drifted = 'x\ny\na\nb\nfoo\nbar\nc\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [
      {
        op: 'replace-range',
        anchor: { line: 3, hash: lineAnchorHash('foo', 3, 4) },
        anchorEnd: { line: 4, hash: lineAnchorHash('bar', 4, 4) },
        payload: ['FOOBAR'],
      },
    ],
  };
  const { result: strict } = applyEditPatch(drifted, patch, sha256Hex);
  t.false(strict.success);
  t.is(failureOf(strict).reason, 'hash-mismatch');
  const { result: relocated, newText: relocatedText } = applyEditPatch(
    drifted,
    patch,
    sha256Hex,
    { reapply: true },
  );
  t.true(relocated.success, JSON.stringify(failureOf(relocated)));
  t.is(relocatedText, 'x\ny\na\nb\nFOOBAR\nc\n');
  // Both range anchors moved down by two; both are reported.
  t.deepEqual(/** @type {any} */ (relocated).relocations, [
    { line: 3, relocatedTo: 5 },
    { line: 4, relocatedTo: 6 },
  ]);
});

test('reapply that inverts a range fails patch-syntax', t => {
  // A `replace-range` whose two anchors drift in opposite directions:
  // the start anchor's content now lives below the end anchor's, so
  // relocation crosses them. The live file is 'B\np\nq\nA\n'; the op
  // was authored with the start anchor (A) at line 2 and the end
  // anchor (B) at line 3, but A now sits at line 4 and B at line 1.
  const live = 'B\np\nq\nA\n';
  const patch = {
    expectedFileHash: hashOfText(live),
    ops: [
      {
        op: 'replace-range',
        anchor: { line: 2, hash: lineAnchorHash('A', 2, 4) },
        anchorEnd: { line: 3, hash: lineAnchorHash('B', 3, 4) },
        payload: ['X'],
      },
    ],
  };
  const { result } = applyEditPatch(live, patch, sha256Hex, { reapply: true });
  t.false(result.success);
  // The endpoints relocate in opposite directions (start +2, end -2): unequal
  // deltas, so the range would be resized/inverted — rejected as patch-syntax.
  t.is(failureOf(result).reason, 'patch-syntax');
});

test('reapply refuses to relocate a narrow (2-char) anchor', t => {
  // A fabricated 2-char anchor that matches an unrelated line inside the window
  // must NOT silently relocate onto it: 8-bit relocation is a 1/256 coin flip.
  // Here `wanted` was authored at line 1 but does not sit there; a 2-char
  // anchor is refused (hash-mismatch), while the same anchor at 4-char width
  // relocates. This pins the width gate that keeps a drifted narrow anchor
  // from splicing onto a wrong line.
  const text = 'alpha\nbeta\ngamma\nwanted\n';
  const narrow = {
    expectedFileHash: hashOfText(text),
    ops: [
      {
        op: 'replace',
        anchor: { line: 1, hash: lineAnchorHash('wanted', 1, 2) },
        payload: ['WANTED'],
      },
    ],
  };
  const { result: refused } = applyEditPatch(text, narrow, sha256Hex, {
    reapply: true,
  });
  t.false(refused.success);
  t.is(failureOf(refused).reason, 'hash-mismatch');

  const wide = {
    expectedFileHash: hashOfText(text),
    ops: [
      {
        op: 'replace',
        anchor: { line: 1, hash: lineAnchorHash('wanted', 1, 4) },
        payload: ['WANTED'],
      },
    ],
  };
  const { result: relocated, newText: relocatedText } = applyEditPatch(
    text,
    wide,
    sha256Hex,
    { reapply: true },
  );
  t.true(relocated.success, JSON.stringify(failureOf(relocated)));
  t.is(relocatedText, 'alpha\nbeta\ngamma\nWANTED\n');
  t.deepEqual(/** @type {any} */ (relocated).relocations, [
    { line: 1, relocatedTo: 4 },
  ]);
});

test('reapply refuses a range op whose endpoints relocate unequally', t => {
  // M3: a range whose END anchor alone drifts (the start still matches in
  // place) would silently swallow extra lines. Both endpoints must relocate by
  // the same delta; a one-sided relocation is rejected, not applied as a wider
  // edit. Here `start` sits where authored (line 2) but `end`, authored at
  // line 3, now lives at line 5 — an expansion the patch never named.
  const live = 'head\nstart\nx\ny\nend\nz\n';
  const patch = {
    expectedFileHash: hashOfText(live),
    ops: [
      {
        op: 'replace-range',
        anchor: { line: 2, hash: lineAnchorHash('start', 2, 4) },
        anchorEnd: { line: 3, hash: lineAnchorHash('end', 3, 4) },
        payload: ['MERGED'],
      },
    ],
  };
  const { result } = applyEditPatch(live, patch, sha256Hex, { reapply: true });
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
  t.regex(failureOf(result).message || '', /unequal deltas|resize/);
});

test('reapply relocates exactly at the window edge and fails one short', t => {
  // The prover's should-fix: pin the exact window boundary. `target` was
  // authored at line 3 but two lines were inserted above, so it now sits at
  // line 5 — a drift distance of exactly 2. At reapplyWindow 2 the bounded
  // search reaches it (relocation); at window 1 it does not (hash-mismatch).
  const drifted = 'x\ny\na\nb\ntarget\n';
  const anchor = { line: 3, hash: lineAnchorHash('target', 3, 4) };
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [{ op: 'replace', anchor, payload: ['TARGET'] }],
  };
  const atEdge = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
    reapplyWindow: 2,
  });
  t.true(atEdge.result.success, JSON.stringify(failureOf(atEdge.result)));
  t.is(atEdge.newText, 'x\ny\na\nb\nTARGET\n');
  t.deepEqual(/** @type {any} */ (atEdge.result).relocations, [
    { line: 3, relocatedTo: 5 },
  ]);
  const oneShort = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
    reapplyWindow: 1,
  });
  t.false(oneShort.result.success);
  t.is(failureOf(oneShort.result).reason, 'hash-mismatch');
});

test('reapply hash checks at the relocated line strip the seed', t => {
  // A blank-line anchor cannot relocate: its hash is seeded with the
  // original line number, so no other blank line matches it.
  const drifted = 'inserted\na\n\nb\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    // HashlineAnchor for the blank line when it sat at line 2.
    ops: [{ op: 'delete', anchor: { line: 2, hash: lineAnchorHash('', 2) } }],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  // The blank line now sits at line 3, and its live hash is seeded
  // with 3, so the line-2-seeded anchor finds no candidate — unless
  // some other line's content hash collides, which `a` and `b` and
  // `inserted` are chosen not to.
  t.false(result.success);
  t.is(failureOf(result).reason, 'hash-mismatch');
});

test('a blank anchor refuses to relocate onto a hash-colliding content line', t => {
  // Load-bearing pin for the `isBlankAnchor` relocation guard: the previous
  // blank-anchor test's fixture has no window line colliding with the blank
  // seed, so removing the guard leaves it green (the search simply finds zero
  // candidates either way). Here a real content line is chosen to CRC-collide
  // with the blank seed at 4-char width, so without the guard the blank anchor
  // relocates onto it and silently deletes it.
  //
  // `lineAnchorHash('', 2, 4) === 'abf5'`, and so does
  // `lineAnchorHash('const x = 89216;', 3, 4)` (a 16-bit collision). The blank
  // anchor authored for line 2 must NOT relocate onto the content line now at
  // line 3.
  t.is(lineAnchorHash('', 2, 4), 'abf5');
  t.is(lineAnchorHash('const x = 89216;', 3, 4), 'abf5');
  const drifted = 'alpha\nbeta\nconst x = 89216;\ngamma\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [{ op: 'delete', anchor: { line: 2, hash: 'abf5' } }],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  // Guard present: the position-bound blank anchor does not relocate, so the
  // colliding content line is untouched and the edit fails cleanly. Guard
  // removed: the blank anchor relocates to line 3 and deletes `const x = 89216;`.
  t.false(result.success);
  t.is(failureOf(result).reason, 'hash-mismatch');
});

test('reapply fails ambiguous-reapply on duplicate candidates', t => {
  const drifted = 'pad\ndup\nmid\ndup\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    // An anchor for `dup` authored at a line where it no longer sits. A 4-char
    // anchor is required for relocation; `dup` still collides at 16 bits (same
    // content, same hash), so it resolves to two candidates and is ambiguous.
    ops: [
      {
        op: 'replace',
        anchor: { line: 3, hash: lineAnchorHash('dup', 3, 4) },
        payload: ['DUP'],
      },
    ],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  t.false(result.success);
  const failure = failureOf(result);
  t.is(failure.reason, 'ambiguous-reapply');
  // Nearest-first, lower line first on ties: distance 1 (lines 2, 4).
  t.deepEqual(failure.ambiguities, [{ line: 3, candidates: [2, 4] }]);
});

test('ambiguous-reapply also carries a coexisting zero-candidate mismatch', t => {
  // Regression: when one anchor is ambiguous (multiple candidates) and
  // another is genuinely unlocatable (zero candidates), the failure must
  // report BOTH — the ambiguities as the reason and the unlocatable
  // anchor in `mismatches` — rather than silently dropping the mismatch.
  const drifted = 'dup\nz\ndup\nq\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [
      // `dup` sits at lines 1 and 3, so an anchor authored at line 2
      // relocates ambiguously. 4-char anchors are required to relocate.
      {
        op: 'replace',
        anchor: { line: 2, hash: lineAnchorHash('dup', 2, 4) },
        payload: ['DUP'],
      },
      // A second anchor whose content matches no live line: zero
      // relocation candidates, a genuine hash-mismatch.
      {
        op: 'delete',
        anchor: { line: 4, hash: lineAnchorHash('absent', 4, 4) },
      },
    ],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  t.false(result.success);
  const failure = failureOf(result);
  t.is(failure.reason, 'ambiguous-reapply');
  t.deepEqual(failure.ambiguities, [{ line: 2, candidates: [1, 3] }]);
  // The unlocatable anchor survives alongside the ambiguity. Its
  // patch-width column is 4-char (the anchor's declared width); the
  // file-native width is 2-char (the drifted file has 4 lines).
  t.deepEqual(failure.mismatches, [
    {
      line: 4,
      hashExpected: lineAnchorHash('absent', 4, 4),
      hashActualAtPatchWidth: lineAnchorHash('q', 4, 4),
      hashActualAtFileWidth: lineAnchorHash('q', 4, 2),
    },
  ]);
});

test('a blank anchor never collides with a bare-digit content line', t => {
  // Regression: the blank-line seed carries a leading LF (`\n${line}`),
  // a byte no content line can hold, so a blank line at line N and a
  // content line whose trimmed text is literally "N" no longer hash
  // identically. Before the sentinel this collision was deterministic,
  // letting a blank anchor silently relocate onto (or strict-match) a
  // bare-digit line.
  t.not(lineAnchorHash('', 2), lineAnchorHash('2', 2));
  t.not(lineAnchorHash('', 2), lineAnchorHash('2', 7));

  // A blank line authored at line 2, now drifted, with a content line
  // "2" sitting inside the reapply window. The blank anchor must find no
  // candidate rather than relocating onto the digit line.
  const drifted = 'head\nx\ny\n2\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    ops: [{ op: 'delete', anchor: { line: 2, hash: lineAnchorHash('', 2) } }],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  t.false(result.success);
  t.is(failureOf(result).reason, 'hash-mismatch');
});

test('reapply does not search beyond the window', t => {
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`);
  const text = `target\n${filler.join('\n')}\n`;
  const patch = {
    expectedFileHash: hashOfText(text),
    // Authored as if `target` sat at line 40; it sits at line 1,
    // outside a ±20 window around 40... except line 40-20=20 > 1.
    ops: [
      {
        op: 'replace',
        anchor: { line: 40, hash: lineAnchorHash('target', 40, 4) },
        payload: ['TARGET'],
      },
    ],
  };
  const { result: defaultWindow } = applyEditPatch(text, patch, sha256Hex, {
    reapply: true,
  });
  t.false(defaultWindow.success);
  t.is(failureOf(defaultWindow).reason, 'hash-mismatch');
  const { result: wide } = applyEditPatch(text, patch, sha256Hex, {
    reapply: true,
    reapplyWindow: 100,
  });
  t.true(wide.success);
});

test('reapply does not relax the file-level CAS', t => {
  const text = 'a\n';
  const patch = {
    expectedFileHash: EMPTY_FILE_SHA256,
    ops: [{ op: 'append', payload: ['x'] }],
  };
  const { result } = applyEditPatch(text, patch, sha256Hex, { reapply: true });
  t.false(result.success);
  t.is(failureOf(result).reason, 'file-rev-mismatch');
});

test('applyEditPatch validates its options', t => {
  const text = 'a\n';
  const patch = patchFor(text, [{ op: 'append', payload: ['x'] }]);
  // The mount-supplied `sha256Hex` power (3rd arg) is a wiring precondition, so
  // a non-function throws rather than degrading to a structured failure.
  t.throws(() => applyEditPatch(text, patch, /** @type {any} */ (undefined)));

  // The guest-tunable `options` bag (4th arg) never escapes the
  // structured-failure contract: every malformation is a `patch-syntax`
  // failure, not a raw engine throw.
  const patchSyntaxFor = options => {
    const { result } = applyEditPatch(
      text,
      patch,
      sha256Hex,
      /** @type {any} */ (options),
    );
    t.false(result.success);
    t.is(failureOf(result).reason, 'patch-syntax');
  };
  // `reapplyWindow` must be an integer in [1, 200].
  patchSyntaxFor({ reapplyWindow: 0 });
  patchSyntaxFor({ reapplyWindow: 201 });
  // `options: null` must not throw a raw `TypeError` off the destructuring
  // default (which only fires for `undefined`).
  patchSyntaxFor(null);
  // A non-object `options` is rejected in shape.
  patchSyntaxFor(42);
  // A present-but-wrong `reapply` (a truthy non-boolean must not silently
  // enable relocation while `reapplyWindow` is strictly validated).
  patchSyntaxFor({ reapply: 'nope' });
  // A hostile accessor that throws while the bag is read is caught, not
  // propagated.
  patchSyntaxFor({
    get reapply() {
      throw Error('boom');
    },
  });
});

test('reapply refuses to relocate a blank-line anchor at any width', t => {
  // M4: a blank line's anchor is seeded with its authored line number, so a
  // moved blank line can only "match" a new line by hash collision. Even at
  // 4-char width (past the narrow-anchor gate), a blank anchor is refused
  // relocation outright rather than allowed to collide onto a content line.
  const drifted = 'inserted\nkept\n\ntail\n';
  const patch = {
    expectedFileHash: hashOfText(drifted),
    // The blank line was authored at line 2; it now sits at line 3.
    ops: [
      { op: 'delete', anchor: { line: 2, hash: lineAnchorHash('', 2, 4) } },
    ],
  };
  const { result } = applyEditPatch(drifted, patch, sha256Hex, {
    reapply: true,
  });
  t.false(result.success);
  t.is(failureOf(result).reason, 'hash-mismatch');
});

// --- validateEditPatch / applyEditPatch: sparse-array hardening ---

test('a sparse ops array is rejected, not spliced past its holes', t => {
  // M5: `Array.prototype.map` skips holes, so a hole in `ops` would slip past
  // the per-op validator and later throw a raw TypeError out of the structured
  // failure contract. Validation reads every index, so the hole is seen as
  // `undefined` and rejected.
  const ops = [];
  ops[1] = { op: 'append', payload: ['x'] }; // leaves a hole at index 0
  t.throws(() =>
    validateEditPatch({ expectedFileHash: EMPTY_FILE_SHA256, ops }),
  );
  // And through applyEditPatch it is a structured patch-syntax failure, not a
  // throw.
  const { result } = applyEditPatch(
    '',
    { expectedFileHash: EMPTY_FILE_SHA256, ops },
    sha256Hex,
  );
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
});

test('a sparse payload array is rejected, not spliced as a blank line', t => {
  const payload = ['a'];
  payload[2] = 'c'; // hole at index 1
  t.throws(() =>
    validateEditPatch({
      expectedFileHash: EMPTY_FILE_SHA256,
      ops: [{ op: 'append', payload }],
    }),
  );
});

test('a payload line with an unpaired surrogate is rejected', t => {
  // The anchor CRC32 and the CAS SHA-256 both hash the UTF-8 encoding, and
  // `TextEncoder` folds every unpaired surrogate to U+FFFD — so an unpaired
  // surrogate is not injective under either hash and cannot round-trip a UTF-8
  // write. Through `validateEditPatch` it throws; through `applyEditPatch` it is
  // a structured `patch-syntax` failure.
  const surrogate = 'a\uD800b';
  t.throws(() =>
    validateEditPatch({
      expectedFileHash: EMPTY_FILE_SHA256,
      ops: [{ op: 'append', payload: [surrogate] }],
    }),
  );
  const { result } = applyEditPatch(
    '',
    {
      expectedFileHash: EMPTY_FILE_SHA256,
      ops: [{ op: 'append', payload: [surrogate] }],
    },
    sha256Hex,
  );
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
});

// --- CRLF-authored patch text ---

test('a CRLF-authored patch parses and applies like an LF one', t => {
  // M6: the textual patch transport may arrive with CRLF endings (Windows
  // editors, core.autocrlf, HTML form submission). The parser strips a trailing
  // CR per line so a payload never smuggles a stray carriage return into the
  // file, and a CRLF blank separator does not misparse.
  const text = 'one\ntwo\nthree\n';
  const patchText = [
    `@expected-file-hash ${hashOfText(text)}`,
    `@replace 2#${lineAnchorHash('two', 2)}`,
    '| TWO',
    '',
  ].join('\r\n');
  const patch = parseHashlineText(patchText);
  t.deepEqual(/** @type {any} */ (patch.ops[0]).payload, ['TWO']); // no trailing '\r'
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success, JSON.stringify(failureOf(result)));
  t.is(newText, 'one\nTWO\nthree\n');
});

test('the hashline-json payload validator rejects an embedded carriage return', t => {
  // M6: on the structured path a CR is not a transport artifact but a smuggled
  // control character, rejected alongside LF so one payload entry stays one
  // physical line.
  t.throws(() =>
    validateEditPatch({
      expectedFileHash: EMPTY_FILE_SHA256,
      ops: [{ op: 'append', payload: ['a\rb'] }],
    }),
  );
});

// --- load-bearing guard regression evidence ---

test('a range op composes correctly with a higher-line single-line op', t => {
  // M8: `actions.sort` is load-bearing. A range op listed AFTER a single-line
  // op that sits at a higher line arrives out of order; unsorted, the splice
  // walk would emit lines out of order and duplicate content. This pins the
  // sort.
  const text = 'a\nb\nc\nd\ne\n';
  const patch = patchFor(text, [
    { op: 'insert-after', line: 4, payload: ['X'] },
    { op: 'replace-range', line: 2, lineEnd: 3, payload: ['BC'] },
  ]);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success, JSON.stringify(failureOf(result)));
  t.is(newText, 'a\nBC\nd\nX\ne\n');
});

test('a very large payload applies without a RangeError', t => {
  // Fail fast rather than hang to the package timeout on a regression.
  t.timeout(60_000);
  // M8: payload assembly appends element-by-element rather than spreading the
  // array into `push`/`splice` (`push(...payload)`), whose argument count is
  // bounded by the engine stack and throws a RangeError — an engine-dependent
  // failure that escapes the structured-failure contract. The threshold is
  // larger inside an ava worker than on the bare main thread (a bigger stack),
  // so this count is set well above the worker's spread limit: a spread-based
  // assembly throws here, an element-by-element append does not. (Verified: a
  // `push(...payload)` mutant fails this test at this count while the shipped
  // loop passes.)
  const lineCount = 1_000_000;
  const payload = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
  const { result, newText } = applyEditPatch(
    '',
    { expectedFileHash: EMPTY_FILE_SHA256, ops: [{ op: 'append', payload }] },
    sha256Hex,
  );
  t.true(result.success, JSON.stringify(failureOf(result)));
  const { lines } = splitLines(/** @type {string} */ (newText));
  t.is(lines.length, lineCount);
  t.is(lines[0], 'line 0');
  t.is(lines[lineCount - 1], `line ${lineCount - 1}`);
});

test('a spliced result over the character cap fails patch-syntax, not a RangeError', t => {
  // Fail fast rather than hang to the package timeout on a regression.
  t.timeout(60_000);
  // The breaker/assessor must-fix: a caller-controlled payload past the engine
  // string-length ceiling (`MAX_RESULT_CHARS`, 256 MiB = 0x1000_0000) would make
  // `joinLines` throw a raw `RangeError: Invalid string length` out of the
  // structured contract. It must instead be a `patch-syntax` failure. The same
  // 2**27-char line is referenced repeatedly so the fixture costs one
  // allocation, not three, while their summed length (3 * 2**27 > 2**28) trips
  // the cap.
  const big = 'x'.repeat(2 ** 27); // 134_217_728 chars
  const { result } = applyEditPatch(
    '',
    {
      expectedFileHash: EMPTY_FILE_SHA256,
      ops: [{ op: 'append', payload: [big, big, big] }],
    },
    sha256Hex,
  );
  t.false(result.success);
  t.is(failureOf(result).reason, 'patch-syntax');
});

// --- round-trip: render, author, apply ---

test('a patch authored from the rendered view applies cleanly', t => {
  const text = 'alpha\nbeta\ngamma\n';
  const rendered = renderHashlineLines(text);
  // Recover the anchor for `beta` from the rendered annotation.
  const match = /^\s*(\d+)#([0-9a-f]+) beta$/.exec(rendered[1]);
  t.truthy(match);
  const [, lineText, hash] = /** @type {RegExpExecArray} */ (match);
  const patchText = [
    `@expected-file-hash ${hashOfText(text)}`,
    `@replace ${lineText}#${hash}`,
    '| BETA',
    '',
  ].join('\n');
  const patch = parseHashlineText(patchText);
  const { result, newText } = applyEditPatch(text, patch, sha256Hex);
  t.true(result.success);
  t.is(newText, 'alpha\nBETA\ngamma\n');
});
