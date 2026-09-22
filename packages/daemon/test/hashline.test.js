// Unit tests for the pure hashline edit-patch module
// (`packages/daemon/src/hashline.js`), per the design's Test Plan in
// `designs/cli-edit-verb.md`. These exercise the tokenizer, the JSON
// validator, the CRC32 per-line hash, the SHA-256 whole-file hash, the
// anchor CAS, the reapply relocation, and the line splice — all without
// a daemon (the daemon-side integration lives in `endo.test.js`).

import test from '@endo/ses-ava/prepare-endo.js';

import {
  anchorWidthForLineCount,
  applyPatch,
  byteLength,
  computeFileHash,
  computeLineHash,
  describePatchProblem,
  joinLines,
  parseHashlineJson,
  parseHashlineText,
  renderAnchored,
  resolveAnchors,
  splitLines,
  validateAnchors,
  validateEditPatch,
} from '../src/hashline.js';

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// --- splitLines / joinLines -----------------------------------------

test('splitLines: trailing newline tracked and round-trips', t => {
  for (const content of [
    '',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    '\n',
    '\n\n',
    'a\r\nb\r\n',
  ]) {
    const parts = splitLines(content);
    t.is(joinLines(parts), content, `round-trip ${JSON.stringify(content)}`);
  }
});

test('splitLines: empty file has no lines but trailingNewline true', t => {
  t.deepEqual(splitLines(''), { lines: [], trailingNewline: true });
});

test('splitLines: CRLF stays on the line content', t => {
  const parts = splitLines('a\r\nb\r\n');
  t.deepEqual(parts.lines, ['a\r', 'b\r']);
  t.true(parts.trailingNewline);
});

// --- CRC32 per-line hash --------------------------------------------

test('computeLineHash: width 2 vs 4 and determinism', t => {
  const h2 = computeLineHash('const x = 1;', 5, 2);
  const h4 = computeLineHash('const x = 1;', 5, 4);
  t.is(h2.length, 2);
  t.is(h4.length, 4);
  t.true(/^[0-9a-f]+$/.test(h4));
  // Width 2 is the low byte of the width-4 value.
  t.is(h2, h4.slice(2));
  t.is(computeLineHash('const x = 1;', 5, 2), h2, 'deterministic');
});

test('computeLineHash: trailing whitespace and CRLF ignored, leading kept', t => {
  const base = computeLineHash('  indented', 1, 2);
  t.is(computeLineHash('  indented   ', 1, 2), base, 'trailing ws stripped');
  t.is(computeLineHash('  indented\r', 1, 2), base, 'trailing CR stripped');
  t.not(computeLineHash('indented', 1, 2), base, 'leading ws significant');
});

test('computeLineHash: blank lines seeded by line number', t => {
  t.not(computeLineHash('', 1, 2), computeLineHash('', 2, 2));
  t.not(computeLineHash('   ', 3, 2), computeLineHash('   ', 4, 2));
  // A whitespace-only line hashes the same as an empty one at the same
  // line number (both normalize to the seed).
  t.is(computeLineHash('', 7, 2), computeLineHash('  \t ', 7, 2));
});

test('anchorWidthForLineCount: 2 up to 4096, 4 above', t => {
  t.is(anchorWidthForLineCount(0), 2);
  t.is(anchorWidthForLineCount(4096), 2);
  t.is(anchorWidthForLineCount(4097), 4);
});

// --- SHA-256 whole-file hash ----------------------------------------

test('computeFileHash: empty file canonical hash', async t => {
  t.is(await computeFileHash(''), EMPTY_SHA256);
});

test('computeFileHash: known vectors', async t => {
  t.is(
    await computeFileHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  // Multi-byte UTF-8 is hashed as bytes.
  t.is((await computeFileHash('λ')).length, 64);
});

test('byteLength counts UTF-8 bytes', t => {
  t.is(byteLength('abc'), 3);
  t.is(byteLength('λ'), 2);
  t.is(byteLength('☃'), 3);
});

// --- renderAnchored (read-side attribution) -------------------------

test('renderAnchored: LINE#HASH prefix per line, hashes match', t => {
  const content = '# Title\n\nBuy milk.\n';
  const rendered = renderAnchored(content);
  const lines = rendered.split('\n');
  t.is(lines.length, 3);
  t.regex(lines[0], /^1#[0-9a-f]{2} # Title$/);
  t.regex(lines[1], /^2#[0-9a-f]{2} $/);
  t.regex(lines[2], /^3#[0-9a-f]{2} Buy milk\.$/);
  // The rendered anchor equals the recomputed per-line hash.
  const match = /^3#([0-9a-f]{2})/.exec(lines[2]);
  t.is(match && match[1], computeLineHash('Buy milk.', 3, 2));
});

// --- textual parser --------------------------------------------------

test('parseHashlineText: header, ops, payload, comments, blanks', t => {
  const text = [
    '# a comment',
    `@expected-file-hash ${EMPTY_SHA256}`,
    '@replace 4#7e',
    '| Buy eggs (the brown ones).',
    '',
    '@insert-after 4#7e',
    '| Buy bread.',
    '| ',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.is(patch.expectedFileHash, EMPTY_SHA256);
  t.is(patch.ops.length, 2);
  t.deepEqual(patch.ops[0], {
    op: 'replace',
    anchor: { line: 4, hash: '7e' },
    payload: ['Buy eggs (the brown ones).'],
  });
  t.deepEqual(patch.ops[1], {
    op: 'insert-after',
    anchor: { line: 4, hash: '7e' },
    payload: ['Buy bread.', ''],
  });
});

test('parseHashlineText: range op via .. becomes replace-range', t => {
  const text = [
    `@expected-file-hash ${EMPTY_SHA256}`,
    '@replace 2#aa..4#bc',
    '| one line',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.is(patch.ops[0].op, 'replace-range');
  t.deepEqual(patch.ops[0].anchor, { line: 2, hash: 'aa' });
  t.deepEqual(patch.ops[0].anchorEnd, { line: 4, hash: 'bc' });
});

test('parseHashlineText: prepend/append take no anchor', t => {
  const text = [
    `@expected-file-hash ${EMPTY_SHA256}`,
    '@prepend',
    '| #!/usr/bin/env node',
    '@append',
    '| // end',
  ].join('\n');
  const patch = parseHashlineText(text);
  t.is(patch.ops[0].op, 'prepend');
  t.is(patch.ops[0].anchor, undefined);
  t.is(patch.ops[1].op, 'append');
});

test('parseHashlineText: missing header is a syntax error', t => {
  t.throws(() => parseHashlineText('@append\n| x'), {
    message: /missing @expected-file-hash/,
  });
});

test('parseHashlineText: unknown op is a syntax error', t => {
  t.throws(
    () =>
      parseHashlineText(
        `@expected-file-hash ${EMPTY_SHA256}\n@frobnicate 1#aa`,
      ),
    { message: /unknown op/ },
  );
});

// --- JSON validator --------------------------------------------------

test('parseHashlineJson: accepts object and JSON string', t => {
  const obj = {
    expectedFileHash: EMPTY_SHA256,
    ops: [{ op: 'append', payload: ['x'] }],
  };
  t.deepEqual(parseHashlineJson(obj), obj);
  t.deepEqual(parseHashlineJson(JSON.stringify(obj)), obj);
});

test('describePatchProblem: catches malformed envelopes', t => {
  t.regex(describePatchProblem(null) || '', /must be an object/);
  t.regex(describePatchProblem({ ops: [] }) || '', /expectedFileHash/);
  t.regex(
    describePatchProblem({ expectedFileHash: 'short', ops: [] }) || '',
    /expectedFileHash/,
  );
  t.regex(
    describePatchProblem({ expectedFileHash: EMPTY_SHA256, ops: 'no' }) || '',
    /ops must be an array/,
  );
  t.regex(
    describePatchProblem({
      expectedFileHash: EMPTY_SHA256,
      ops: [
        { op: 'replace', anchor: { line: 1, hash: 'aa' }, payload: ['a\nb'] },
      ],
    }) || '',
    /embedded newline/,
  );
  t.regex(
    describePatchProblem({
      expectedFileHash: EMPTY_SHA256,
      ops: [
        { op: 'replace', anchor: { line: 1, hash: 'aa' }, payload: ['x'] },
        { op: 'replace', anchor: { line: 1, hash: 'bb' }, payload: ['y'] },
      ],
    }) || '',
    /consumed by more than one/,
  );
  t.is(
    describePatchProblem({
      expectedFileHash: EMPTY_SHA256,
      ops: [{ op: 'append', payload: ['x'] }],
    }),
    undefined,
  );
});

test('validateEditPatch: throws on malformed, returns on valid', t => {
  t.throws(() => validateEditPatch({ ops: [] }), { message: /patch-syntax/ });
  const good = {
    expectedFileHash: EMPTY_SHA256,
    ops: [{ op: 'append', payload: ['x'] }],
  };
  t.is(validateEditPatch(good), good);
});

// --- anchor validation ----------------------------------------------

const anchoredPatch = content => {
  const parts = splitLines(content);
  const width = anchorWidthForLineCount(parts.lines.length);
  return {
    parts,
    width,
    anchorOf: line => ({
      line,
      hash: computeLineHash(parts.lines[line - 1], line, width),
    }),
  };
};

test('validateAnchors: matches yield empty, drift yields mismatch', t => {
  const content = 'alpha\nbeta\ngamma\n';
  const { parts, anchorOf } = anchoredPatch(content);
  const good = {
    expectedFileHash: EMPTY_SHA256,
    ops: [{ op: 'replace', anchor: anchorOf(2), payload: ['BETA'] }],
  };
  t.deepEqual(validateAnchors(good, parts), []);

  const realHash = anchorOf(2).hash;
  const wrongHash = realHash === 'aa' ? 'bb' : 'aa';
  const stale = {
    expectedFileHash: EMPTY_SHA256,
    ops: [
      { op: 'replace', anchor: { line: 2, hash: wrongHash }, payload: ['x'] },
    ],
  };
  const mismatches = validateAnchors(stale, parts);
  t.is(mismatches.length, 1);
  t.is(mismatches[0].line, 2);
  t.is(mismatches[0].hashExpected, wrongHash);
  t.is(mismatches[0].hashActualAtPatchWidth, computeLineHash('beta', 2, 2));
});

// --- splice ----------------------------------------------------------

const applyText = (content, ops, options) => {
  const parts = splitLines(content);
  const patch = { expectedFileHash: EMPTY_SHA256, ops };
  const resolution = resolveAnchors(patch, parts, options);
  if (resolution.status !== 'ok') {
    throw new Error(`resolveAnchors not ok: ${JSON.stringify(resolution)}`);
  }
  return joinLines(applyPatch(resolution.patch, parts));
};

test('applyPatch: worked example from the design', t => {
  const content = '# Today\n\nBuy milk.\nBuy eggs.\n';
  const { anchorOf } = anchoredPatch(content);
  const out = applyText(content, [
    { op: 'replace', anchor: anchorOf(4), payload: ['Buy eggs (brown).'] },
    { op: 'insert-after', anchor: anchorOf(4), payload: ['Buy bread.'] },
  ]);
  t.is(out, '# Today\n\nBuy milk.\nBuy eggs (brown).\nBuy bread.\n');
});

test('applyPatch: multi-op bottom-up keeps anchors stable', t => {
  const content = 'one\ntwo\nthree\nfour\nfive\n';
  const { anchorOf } = anchoredPatch(content);
  const out = applyText(content, [
    { op: 'delete', anchor: anchorOf(2) },
    { op: 'insert-before', anchor: anchorOf(4), payload: ['3.5'] },
    { op: 'replace', anchor: anchorOf(5), payload: ['FIVE'] },
  ]);
  t.is(out, 'one\nthree\n3.5\nfour\nFIVE\n');
});

test('applyPatch: prepend/append and range delete', t => {
  const content = 'a\nb\nc\nd\n';
  const { anchorOf } = anchoredPatch(content);
  const out = applyText(content, [
    { op: 'prepend', payload: ['HEAD'] },
    { op: 'append', payload: ['TAIL'] },
    { op: 'delete', anchor: anchorOf(2), anchorEnd: anchorOf(3) },
  ]);
  t.is(out, 'HEAD\na\nd\nTAIL\n');
});

test('applyPatch: replace-range collapses inclusive span', t => {
  const content = 'a\nb\nc\nd\n';
  const { anchorOf } = anchoredPatch(content);
  const out = applyText(content, [
    {
      op: 'replace-range',
      anchor: anchorOf(2),
      anchorEnd: anchorOf(3),
      payload: ['B+C'],
    },
  ]);
  t.is(out, 'a\nB+C\nd\n');
});

test('applyPatch: no trailing newline is preserved', t => {
  const content = 'a\nb';
  const { anchorOf } = anchoredPatch(content);
  const out = applyText(content, [
    { op: 'replace', anchor: anchorOf(1), payload: ['A'] },
  ]);
  t.is(out, 'A\nb');
});

test('applyPatch: populate empty file via append', t => {
  const out = applyText('', [{ op: 'append', payload: ['first', 'second'] }]);
  t.is(out, 'first\nsecond\n');
});

// --- reapply relocation ---------------------------------------------

test('resolveAnchors: strict mode fails on drift', t => {
  const content = 'a\nb\nc\n';
  const parts = splitLines(content);
  const realHash = computeLineHash('b', 2, 2);
  const wrongHash = realHash === 'aa' ? 'bb' : 'aa';
  const patch = {
    expectedFileHash: EMPTY_SHA256,
    ops: [
      { op: 'replace', anchor: { line: 2, hash: wrongHash }, payload: ['B'] },
    ],
  };
  const res = resolveAnchors(patch, parts);
  t.is(res.status, 'hash-mismatch');
});

test('resolveAnchors: reapply relocates a single-candidate anchor', t => {
  // Author an anchor for "target" at its original line 1, then shift it
  // down by two lines; reapply should find it at line 3.
  const anchor = { line: 1, hash: computeLineHash('target', 1, 2) };
  const shifted = 'pad0\npad1\ntarget\n';
  const parts = splitLines(shifted);
  const patch = {
    expectedFileHash: EMPTY_SHA256,
    ops: [{ op: 'replace', anchor, payload: ['HIT'] }],
  };
  const strict = resolveAnchors(patch, parts);
  t.is(strict.status, 'hash-mismatch', 'line 1 no longer matches');
  const relaxed = resolveAnchors(patch, parts, { reapply: true });
  t.is(relaxed.status, 'ok');
  if (relaxed.status === 'ok') {
    t.is(joinLines(applyPatch(relaxed.patch, parts)), 'pad0\npad1\nHIT\n');
  }
});

test('resolveAnchors: reapply is ambiguous with two candidates', t => {
  const content = 'dup\nx\ndup\n';
  const anchor = { line: 2, hash: computeLineHash('dup', 1, 2) };
  const parts = splitLines(content);
  const patch = {
    expectedFileHash: EMPTY_SHA256,
    ops: [{ op: 'replace', anchor, payload: ['Y'] }],
  };
  const res = resolveAnchors(patch, parts, { reapply: true });
  t.is(res.status, 'ambiguous-reapply');
  if (res.status === 'ambiguous-reapply') {
    t.deepEqual([...res.candidates].sort((a, b) => a - b), [1, 3]);
  }
});
