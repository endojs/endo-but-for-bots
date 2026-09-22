// Unit tests for the pure hashline edit-patch module
// (`src/hashline.js`), per `designs/cli-edit-verb.md` Phase 2.
//
// These exercise the splice/validator in isolation (no daemon, no
// worker). The end-to-end demonstration through the guest surface lives
// in `endo.test.js` ("hashline edit through a guest ...").

import test from '@endo/ses-ava/prepare-endo.js';

import {
  splitLines,
  joinLines,
  computeLineHash,
  computeFileHash,
  validateEditPatch,
  parseHashlineJson,
  parseHashlineText,
  validateAnchors,
  applyPatch,
  hashWidthForLineCount,
  utf8ByteLength,
} from '../src/hashline.js';

// --- splitLines / joinLines ---

test('splitLines/joinLines round-trip preserves trailing newline', t => {
  for (const content of [
    '',
    '\n',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    'a\n\nb\n',
    'line1\nline2\nline3\n',
  ]) {
    const parts = splitLines(content);
    t.is(joinLines(parts), content, `round-trip ${JSON.stringify(content)}`);
  }
});

test('splitLines: empty file is trailingNewline true, zero lines', t => {
  t.deepEqual(splitLines(''), { lines: [], trailingNewline: true });
});

test('splitLines: trailing-newline flag tracks the final byte', t => {
  t.true(splitLines('a\n').trailingNewline);
  t.false(splitLines('a').trailingNewline);
  t.deepEqual(splitLines('a\nb').lines, ['a', 'b']);
  t.deepEqual(splitLines('a\nb\n').lines, ['a', 'b']);
});

test('splitLines: CRLF stays on the line content byte-for-byte', t => {
  const content = 'a\r\nb\r\n';
  const parts = splitLines(content);
  t.deepEqual(parts.lines, ['a\r', 'b\r']);
  t.is(joinLines(parts), content, 'CRLF round-trips byte-for-byte');
});

// --- computeLineHash (CRC32 per-line anchor) ---

test('computeLineHash: known CRC32 vector for "abc"', t => {
  // CRC32("abc") === 0x352441c2; low 8 bits -> "c2", low 16 -> "41c2".
  t.is(computeLineHash('abc', 1, 2), 'c2');
  t.is(computeLineHash('abc', 1, 4), '41c2');
});

test('computeLineHash: width controls hex length', t => {
  t.is(computeLineHash('hello world', 1, 2).length, 2);
  t.is(computeLineHash('hello world', 1, 4).length, 4);
});

test('computeLineHash: strips trailing CR and trailing whitespace', t => {
  t.is(computeLineHash('abc\r', 5, 4), computeLineHash('abc', 5, 4));
  t.is(computeLineHash('abc   \t', 5, 4), computeLineHash('abc', 5, 4));
  t.not(
    computeLineHash(' abc', 5, 4),
    computeLineHash('abc', 5, 4),
    'leading whitespace is significant',
  );
});

test('computeLineHash: blank lines are seeded by line number', t => {
  // Two blank lines at different positions must not collide.
  t.not(computeLineHash('', 2, 2), computeLineHash('', 4, 2));
  // A whitespace-only line normalizes to blank and is seeded too.
  t.is(computeLineHash('   ', 3, 2), computeLineHash('', 3, 2));
});

test('hashWidthForLineCount: 2 up to 4096 lines, 4 above', t => {
  t.is(hashWidthForLineCount(1), 2);
  t.is(hashWidthForLineCount(4096), 2);
  t.is(hashWidthForLineCount(4097), 4);
});

// --- computeFileHash (SHA-256 whole-file CAS) ---

test('computeFileHash: empty file is the canonical SHA-256', async t => {
  t.is(
    await computeFileHash(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('computeFileHash: known SHA-256 vector for "abc"', async t => {
  t.is(
    await computeFileHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('computeFileHash: multi-byte Unicode content', async t => {
  // "abc" with a trailing snowman; distinct from the ASCII prefix.
  const withUnicode = await computeFileHash('abc☃');
  t.is(withUnicode.length, 64);
  t.not(withUnicode, await computeFileHash('abc'));
  t.is(utf8ByteLength('☃'), 3, 'snowman is 3 UTF-8 bytes');
});

// --- validateEditPatch / parseHashlineJson ---

const goodHash = 'a'.repeat(64);

test('validateEditPatch: accepts a well-formed envelope', t => {
  const patch = {
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: { line: 2, hash: 'ab' }, payload: ['x'] }],
  };
  const validated = validateEditPatch(patch);
  t.is(validated.ops.length, 1);
  t.is(validated.ops[0].op, 'replace');
});

test('validateEditPatch: rejects a bad expectedFileHash', t => {
  t.throws(() => validateEditPatch({ expectedFileHash: 'nope', ops: [] }), {
    message: /expectedFileHash/,
  });
});

test('validateEditPatch: rejects an embedded newline in payload', t => {
  t.throws(
    () =>
      validateEditPatch({
        expectedFileHash: goodHash,
        ops: [{ op: 'prepend', payload: ['a\nb'] }],
      }),
    { message: /embedded newline/ },
  );
});

test('validateEditPatch: rejects two replaces on the same line', t => {
  t.throws(
    () =>
      validateEditPatch({
        expectedFileHash: goodHash,
        ops: [
          { op: 'replace', anchor: { line: 3, hash: 'ab' }, payload: ['x'] },
          { op: 'replace', anchor: { line: 3, hash: 'ab' }, payload: ['y'] },
        ],
      }),
    { message: /duplicate replace/ },
  );
});

test('parseHashlineJson: parses a JSON string envelope', t => {
  const patch = parseHashlineJson(
    JSON.stringify({
      expectedFileHash: goodHash,
      ops: [{ op: 'append', payload: ['tail'] }],
    }),
  );
  t.is(patch.ops[0].op, 'append');
});

// --- validateAnchors ---

test('validateAnchors: empty when every anchor matches', t => {
  const parts = splitLines('alpha\nbravo\ncharlie\n');
  const hash2 = computeLineHash('bravo', 2, 2);
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: { line: 2, hash: hash2 }, payload: ['X'] }],
  });
  t.deepEqual(validateAnchors(patch, parts), []);
});

test('validateAnchors: mismatch reports both widths', t => {
  const parts = splitLines('alpha\nbravo\ncharlie\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: { line: 2, hash: '00' }, payload: ['X'] }],
  });
  const mismatches = validateAnchors(patch, parts);
  t.is(mismatches.length, 1);
  t.is(mismatches[0].line, 2);
  t.is(mismatches[0].hashExpected, '00');
  t.is(mismatches[0].hashActualAtPatchWidth, computeLineHash('bravo', 2, 2));
  t.is(mismatches[0].hashActualAtPatchWidth.length, 2);
  t.is(mismatches[0].hashActualAtFileWidth.length, 2);
});

test('validateAnchors: out-of-range line is a mismatch', t => {
  const parts = splitLines('only one line\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'delete', anchor: { line: 9, hash: 'ab' } }],
  });
  const mismatches = validateAnchors(patch, parts);
  t.is(mismatches.length, 1);
  t.is(mismatches[0].line, 9);
});

// --- applyPatch (bottom-up splice) ---

const anchor = (parts, line) => ({
  line,
  hash: computeLineHash(parts.lines[line - 1], line, 2),
});

test('applyPatch: replace one line', t => {
  const parts = splitLines('a\nb\nc\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: anchor(parts, 2), payload: ['B'] }],
  });
  t.is(joinLines(applyPatch(patch, parts)), 'a\nB\nc\n');
});

test('applyPatch: replace one line with many lines', t => {
  const parts = splitLines('a\nb\nc\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: anchor(parts, 2), payload: ['B1', 'B2'] }],
  });
  t.is(joinLines(applyPatch(patch, parts)), 'a\nB1\nB2\nc\n');
});

test('applyPatch: insert-after and insert-before', t => {
  const parts = splitLines('a\nb\nc\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [
      { op: 'insert-after', anchor: anchor(parts, 1), payload: ['after-a'] },
      { op: 'insert-before', anchor: anchor(parts, 3), payload: ['before-c'] },
    ],
  });
  t.is(joinLines(applyPatch(patch, parts)), 'a\nafter-a\nb\nbefore-c\nc\n');
});

test('applyPatch: delete a single line and a range', t => {
  const parts = splitLines('a\nb\nc\nd\ne\n');
  const single = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'delete', anchor: anchor(parts, 3) }],
  });
  t.is(joinLines(applyPatch(single, parts)), 'a\nb\nd\ne\n');

  const range = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [
      { op: 'delete', anchor: anchor(parts, 2), anchorEnd: anchor(parts, 4) },
    ],
  });
  t.is(joinLines(applyPatch(range, parts)), 'a\ne\n');
});

test('applyPatch: replace-range', t => {
  const parts = splitLines('a\nb\nc\nd\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [
      {
        op: 'replace-range',
        anchor: anchor(parts, 2),
        anchorEnd: anchor(parts, 3),
        payload: ['MID'],
      },
    ],
  });
  t.is(joinLines(applyPatch(patch, parts)), 'a\nMID\nd\n');
});

test('applyPatch: prepend and append', t => {
  const parts = splitLines('body\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [
      { op: 'prepend', payload: ['#!/usr/bin/env node'] },
      { op: 'append', payload: ['tail'] },
    ],
  });
  t.is(
    joinLines(applyPatch(patch, parts)),
    '#!/usr/bin/env node\nbody\ntail\n',
  );
});

test('applyPatch: prepend/append populate the empty file', t => {
  const parts = splitLines('');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'append', payload: ['first line'] }],
  });
  t.is(joinLines(applyPatch(patch, parts)), 'first line\n');
});

test('applyPatch: multi-op splice keeps earlier anchors valid', t => {
  // The design's worked example: replace line 4 and insert-after line 4.
  const parts = splitLines("# Today's notes\n\nBuy milk.\nBuy eggs.\n\n");
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [
      {
        op: 'replace',
        anchor: anchor(parts, 4),
        payload: ['Buy eggs (the brown ones).'],
      },
      { op: 'insert-after', anchor: anchor(parts, 4), payload: ['Buy bread.'] },
    ],
  });
  t.is(
    joinLines(applyPatch(patch, parts)),
    "# Today's notes\n\nBuy milk.\nBuy eggs (the brown ones).\nBuy bread.\n\n",
  );
});

test('applyPatch: does not mutate its input parts', t => {
  const parts = splitLines('a\nb\n');
  const patch = validateEditPatch({
    expectedFileHash: goodHash,
    ops: [{ op: 'replace', anchor: anchor(parts, 1), payload: ['A'] }],
  });
  applyPatch(patch, parts);
  t.deepEqual(parts.lines, ['a', 'b'], 'input is untouched');
});

// --- parseHashlineText ---

test('parseHashlineText: the design worked example', t => {
  const text = [
    `@expected-file-hash ${goodHash}`,
    '@replace 4#7e',
    '| Buy eggs (the brown ones).',
    '@insert-after 4#7e',
    '| Buy bread.',
    '',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.is(patch.expectedFileHash, goodHash);
  t.is(patch.ops.length, 2);
  t.deepEqual(patch.ops[0], {
    op: 'replace',
    anchor: { line: 4, hash: '7e' },
    payload: ['Buy eggs (the brown ones).'],
  });
  t.is(patch.ops[1].op, 'insert-after');
});

test('parseHashlineText: range replace becomes replace-range', t => {
  const text = [
    `@expected-file-hash ${goodHash}`,
    '@replace 2#aa..4#bc',
    '| one',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.is(patch.ops[0].op, 'replace-range');
  t.deepEqual(patch.ops[0].anchor, { line: 2, hash: 'aa' });
  t.deepEqual(patch.ops[0].anchorEnd, { line: 4, hash: 'bc' });
});

test('parseHashlineText: comments and empty payload lines', t => {
  const text = [
    '# a leading comment',
    `@expected-file-hash ${goodHash}`,
    '@insert-after 1#a3',
    '|',
    '| after a blank',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.deepEqual(patch.ops[0].payload, ['', 'after a blank']);
});

test('parseHashlineText: missing header is a syntax error', t => {
  t.throws(() => parseHashlineText('@delete 1#a3\n'), {
    message: /@expected-file-hash/,
  });
});
