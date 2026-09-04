// @ts-check

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { M } from '../src/patterns/patternMatchers.js';
import { explainMismatch } from '../src/explain-mismatch.js';

test('returns undefined on match', t => {
  t.is(
    explainMismatch({ specimen: 1n, pattern: M.nat() }),
    undefined,
    'matching specimen returns undefined',
  );
  t.is(
    explainMismatch({ specimen: harden({ a: 1 }), pattern: M.record() }),
    undefined,
    'matching record returns undefined',
  );
  t.is(
    explainMismatch({ specimen: 'hello', pattern: M.string() }),
    undefined,
    'matching string returns undefined',
  );
});

test('simple leaf type mismatch (number vs string) - compact', t => {
  const report = explainMismatch({ specimen: 42, pattern: M.string() });
  t.is(typeof report, 'string', 'report is a string on mismatch');
  const lines = /** @type {string} */ (report).split('\n');
  t.is(lines.length, 1, 'one-leaf compact mismatch fits on one line');
  t.regex(lines[0], /mismatch/i, 'header names the mismatch');
  t.regex(lines[0], /found 42 \(number\)/, 'found column carries the value');
  t.regex(lines[0], /expected/, 'expected column is present');
});

test('simple leaf type mismatch - expanded', t => {
  const report = explainMismatch(
    { specimen: 42, pattern: M.string() },
    { format: 'expanded' },
  );
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch at/, 'expanded form names the mismatch site');
  t.regex(text, /found:\s+42/, 'expanded form labels the found value');
  t.regex(text, /expected:/, 'expanded form labels the expected pattern');
});

test('shape mismatch: copyRecord missing required key - compact', t => {
  const pattern = M.splitRecord({ a: M.number(), b: M.number() });
  const specimen = harden({ a: 1 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /\.b/, 'compact form reports the missing key path');
  t.regex(
    text,
    /missing|Must have/i,
    'compact form names the missing-property reason',
  );
});

test('shape mismatch: copyRecord with wrong-typed leaf - compact', t => {
  const pattern = M.splitRecord({
    user: M.splitRecord({ name: M.string(), age: M.nat() }),
  });
  const specimen = harden({ user: { name: 'kris', age: -3 } });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /\.user\.age/, 'nested path is preserved');
  t.regex(text, /-3/, 'failing value is surfaced');
});

test('nested mismatch (depth > 1) - expanded', t => {
  const pattern = M.splitRecord({
    user: M.splitRecord({ name: M.string(), age: M.nat() }),
  });
  const specimen = harden({ user: { name: 'kris', age: -3 } });
  const report = explainMismatch({ specimen, pattern }, { format: 'expanded' });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch at \.user\.age/, 'header anchors at the deep site');
});

test('M.or reports every alternative - compact', t => {
  const pattern = M.or(M.string(), M.bigint());
  const specimen = 42; // matches neither
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /or, 2 alternatives/, 'header names the disjunction');
  t.regex(text, /alt 0/, 'first alternative reported');
  t.regex(text, /alt 1/, 'second alternative reported');
});

test('M.or reports every alternative - expanded', t => {
  const pattern = M.or(M.string(), M.bigint(), M.boolean());
  const specimen = 42;
  const report = explainMismatch({ specimen, pattern }, { format: 'expanded' });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(
    text,
    /or-disjunction, 3 alternatives/,
    'header names the disjunction',
  );
  t.regex(text, /alt 0:/);
  t.regex(text, /alt 1:/);
  t.regex(text, /alt 2:/);
});

test('arrayOf with multiple bad elements - compact', t => {
  const pattern = M.arrayOf(M.nat());
  const specimen = harden([1n, 2, 3n, -4n, 'five']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /arrayOf, 3 of 5/, 'header carries the totals');
  t.regex(text, /\[1\]/);
  t.regex(text, /\[3\]/);
  t.regex(text, /\[4\]/);
});

test('arrayOf with multiple bad elements - expanded', t => {
  const pattern = M.arrayOf(M.nat());
  const specimen = harden([1n, 2, 3n, -4n, 'five']);
  const report = explainMismatch({ specimen, pattern }, { format: 'expanded' });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /arrayOf over 5 elements; 3 failed/);
  t.regex(text, /at \[1\]/);
});

test('compact output escapes literal pipe in values', t => {
  // A leaf whose rendered specimen contains a literal `|` must not be
  // mistakable for a column separator.
  const report = explainMismatch({ specimen: 'a|b', pattern: M.number() });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // Each row has exactly three ` | ` separators: path | found | expected.
  // Any literal `|` inside the rendered specimen must be escaped to `\|`.
  for (const row of text
    .split('\n')
    .filter(l => l.startsWith('. |') || l.includes(' | '))) {
    const unescapedBars = row.replace(/\\\|/g, '').match(/ \| /g);
    if (unescapedBars) {
      t.true(
        unescapedBars.length <= 3,
        `row has at most three unescaped " | " separators: ${row}`,
      );
    }
  }
});

test('context prefix appears in compact output', t => {
  const report = explainMismatch({
    specimen: 42,
    pattern: M.string(),
    context: 'frob(0)',
  });
  t.is(typeof report, 'string');
  t.regex(/** @type {string} */ (report), /^frob\(0\): /);
});

test('context prefix appears in expanded output', t => {
  const report = explainMismatch(
    { specimen: 42, pattern: M.string(), context: 'frob(0)' },
    { format: 'expanded' },
  );
  t.is(typeof report, 'string');
  t.regex(/** @type {string} */ (report), /^in frob\(0\)/);
});

test('regression: removing the trace recursion makes the deep path test fail', t => {
  // The deep-path regression evidence: a copy-record specimen whose only
  // failure is two levels below the root must surface a path containing
  // both segments. A renderer that fell back to the production matcher's
  // flat colon-joined string would also include both, but a renderer that
  // stopped at depth 1 would not.
  const pattern = M.splitRecord({
    a: M.splitRecord({ b: M.string() }),
  });
  const specimen = harden({ a: { b: 42 } });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.true(text.includes('.a.b'), `report contains '.a.b': ${text}`);
});

test('regression: M.or branches each get their own attribution', t => {
  // Without per-branch attribution, M.or surfaces only "Must match one of",
  // losing per-alternative reasons. The test pins that each alternative
  // contributes its own line.
  const pattern = M.or(M.string(), M.bigint());
  const report = explainMismatch({ specimen: 42, pattern });
  const text = /** @type {string} */ (report);
  // Two alternative lines should be present.
  const altLines = text.split('\n').filter(l => /alt \d/.test(l));
  t.is(altLines.length, 2, `expected two alt lines, got: ${text}`);
});

test('M.and reports every failing branch - compact', t => {
  // A conjunction fails when any branch fails; the renderer should attribute
  // each failing branch to its own row so the caller can address them
  // independently.
  const pattern = M.and(M.number(), M.gte(10), M.lte(5));
  const specimen = 7; // satisfies number, fails gte(10) and lte(5)
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // Both failing branches should surface; the path includes "and branch N".
  t.true(
    text.includes('and branch'),
    `expected and-branch attribution: ${text}`,
  );
});

test('M.and where every branch fails - expanded', t => {
  const pattern = M.and(M.string(), M.number());
  const report = explainMismatch(
    { specimen: true, pattern },
    { format: 'expanded' },
  );
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch at/);
});

test('M.recordOf reports per-value failures', t => {
  // A recordOf whose values fail a sub-pattern: the renderer should
  // attribute each failing value to its own path-step ".key".
  const pattern = M.recordOf(M.string(), M.nat());
  const specimen = harden({ a: 1n, b: -2, c: 3n });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // The failing value at .b should surface; matching entries should not.
  t.true(text.includes('.b'), `report should reference path .b: ${text}`);
});

test('M.recordOf with non-record specimen - compact', t => {
  const pattern = M.recordOf(M.string(), M.nat());
  const specimen = harden([1n, 2n]); // wrong kind
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('M.recordOf reports per-key failures (key pattern)', t => {
  // Bad key-pattern: only certain key shapes are accepted.
  const pattern = M.recordOf(M.string({ stringLengthLimit: 2 }), M.any());
  const specimen = harden({ ok: 1, toolong: 2 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('M.splitArray required-prefix wrong type - compact', t => {
  // The required prefix has a type-mismatch on the second element.
  const pattern = M.splitArray([M.string(), M.nat()]);
  const specimen = harden(['ok', -1, 'extra']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.true(text.includes('[1]'), `report should reference index [1]: ${text}`);
});

test('M.splitArray with optional and rest mismatches', t => {
  const pattern = M.splitArray([M.string()], [M.nat()], M.arrayOf(M.boolean()));
  const specimen = harden(['ok', -1, 'not-a-boolean']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.true(text.includes('[1]'), `expected optional [1] index: ${text}`);
  t.true(text.includes('...rest'), `expected ...rest path: ${text}`);
});

test('M.splitArray too-short array - compact', t => {
  const pattern = M.splitArray([M.string(), M.nat()]);
  const specimen = harden(['only-one']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('M.splitArray with non-array specimen - compact', t => {
  const pattern = M.splitArray([M.string()]);
  const specimen = harden({ a: 1 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('M.splitRecord with optional present and bad', t => {
  const pattern = M.splitRecord({ a: M.string() }, { b: M.nat() });
  const specimen = harden({ a: 'ok', b: -1 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // Optional path-step renders as ".b" via the optional case.
  t.true(text.includes('.b'), `report should reference optional .b: ${text}`);
});

test('M.splitRecord with rest pattern mismatch', t => {
  const pattern = M.splitRecord(
    { a: M.string() },
    {},
    M.recordOf(M.string(), M.nat()),
  );
  const specimen = harden({ a: 'ok', c: -1, d: -2 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // The rest leaf should expose the rest pattern (recordOf) directly as the
  // expected column rather than embedding the whole splitRecord pattern as a
  // single flat leaf. The path-step kind 'rest' renders the path as `...rest`
  // and the expected column carries the recordOf tag with no splitRecord
  // wrapping.
  t.regex(
    text,
    /\.\.\.rest \| found .*\| expected makeTagged\("match:recordOf"/,
    `expected rest leaf with recordOf in the expected column: ${text}`,
  );
});

test('M.splitRecord with non-record specimen', t => {
  const pattern = M.splitRecord({ a: M.string() });
  const specimen = harden([1, 2, 3]);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('copyArray pattern with length mismatch - compact', t => {
  // Two copyArrays of different lengths take the traceLeaf early-return.
  const pattern = harden([M.string(), M.number()]);
  const specimen = harden(['only-one']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('copyArray pattern with per-index mismatches - compact', t => {
  const pattern = harden([M.string(), M.number()]);
  const specimen = harden([42, 'wrong']);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.true(text.includes('[0]'), `expected index [0]: ${text}`);
  t.true(text.includes('[1]'), `expected index [1]: ${text}`);
});

test('copyArray pattern against non-array specimen', t => {
  const pattern = harden([M.string()]);
  const specimen = harden({ 0: 'x' });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('copyRecord pattern with mismatched key set', t => {
  // Different keys take the traceLeaf early-return in the copyRecord branch.
  const pattern = harden({ a: M.string(), b: M.number() });
  const specimen = harden({ a: 'x', c: 1 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('copyRecord pattern with per-key mismatches', t => {
  const pattern = harden({ a: M.string(), b: M.number() });
  const specimen = harden({ a: 1, b: 'wrong' });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.true(text.includes('.a'), `expected .a path: ${text}`);
  t.true(text.includes('.b'), `expected .b path: ${text}`);
});

test('copyRecord pattern against non-record specimen', t => {
  const pattern = harden({ a: M.string() });
  const specimen = harden([1, 2]);
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('opaque tagged pattern (match:kind) surfaces as leaf', t => {
  // A tagged pattern not unrolled by the trace walker (e.g. match:kind)
  // falls through to traceLeaf so a rejection-message line still reaches
  // the renderer.
  const pattern = M.kind('string');
  const specimen = 42;
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('renderFound surfaces bigint, boolean, null specimens distinctly', t => {
  // Each branch of renderFound's switch should appear for a real specimen.
  const r1 = /** @type {string} */ (
    explainMismatch({ specimen: 5n, pattern: M.string() })
  );
  t.regex(r1, /5n|5/, `bigint specimen rendered: ${r1}`);
  const r2 = /** @type {string} */ (
    explainMismatch({ specimen: true, pattern: M.string() })
  );
  t.regex(r2, /true/, `boolean specimen rendered: ${r2}`);
  const r3 = /** @type {string} */ (
    explainMismatch({ specimen: null, pattern: M.string() })
  );
  t.regex(r3, /null/, `null specimen rendered: ${r3}`);
  const r4 = /** @type {string} */ (
    explainMismatch({ specimen: undefined, pattern: M.string() })
  );
  t.regex(r4, /undefined/, `undefined specimen rendered: ${r4}`);
});

test('renderFound surfaces symbol specimen with type tag', t => {
  const sym = Symbol.for('alpha');
  const report = explainMismatch({ specimen: sym, pattern: M.string() });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /\(symbol\)/, `symbol surfaces with type tag: ${text}`);
});

test('M.or expanded carries per-alt reason lines', t => {
  // Hit the reason: branch in the expanded or-renderer.
  const pattern = M.or(M.string(), M.bigint());
  const report = explainMismatch(
    { specimen: 42, pattern },
    { format: 'expanded' },
  );
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /reason:/, `expected reason: line: ${text}`);
});

test('arrayOf expanded carries per-failure reason lines', t => {
  const pattern = M.arrayOf(M.nat());
  const specimen = harden([1n, 'two', 3n]);
  const report = explainMismatch({ specimen, pattern }, { format: 'expanded' });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /reason:/, `expected reason: line: ${text}`);
});

test('renderTrace defaults to compact format when format omitted', t => {
  // The default-format branch in renderTrace (no options.format provided).
  const report = explainMismatch({ specimen: 1, pattern: M.string() });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  // Compact format puts everything on the leaf line with " | " separators.
  t.true(text.includes(' | '), `expected compact separators: ${text}`);
});

test('regression: M.and removed would lose per-branch attribution', t => {
  // Pins the and-branch attribution: a conjunction whose two branches both
  // fail must surface both branch indices in the report.
  const pattern = M.and(M.string(), M.number());
  const specimen = true;
  const report = explainMismatch({ specimen, pattern });
  const text = /** @type {string} */ (report);
  t.true(
    text.includes('and branch 0') && text.includes('and branch 1'),
    `expected both and-branches attributed: ${text}`,
  );
});

test('literal pattern (non-pattern-style) surfaces as leaf', t => {
  // A literal value (a string) used as a pattern is neither copyArray,
  // copyRecord, nor tagged; the trace walker delegates to the production
  // matcher's verdict via the final fall-through traceLeaf.
  const pattern = 'expected-literal';
  const specimen = 'other-literal';
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  t.regex(text, /mismatch/i);
});

test('regression: splitArray index attribution survives the rest pattern', t => {
  // Pins that even when a rest pattern is present, a required-prefix
  // index mismatch keeps its [N] attribution distinct from the rest.
  const pattern = M.splitArray([M.string()], [M.nat()], M.arrayOf(M.boolean()));
  const specimen = harden([42, 'not-a-nat', 0, 1]);
  const report = explainMismatch({ specimen, pattern });
  const text = /** @type {string} */ (report);
  t.true(text.includes('[0]'), `expected required-prefix index [0]: ${text}`);
});

// -------------------------------------------------------------------------
// Multi-branch failures whose per-branch explanation is itself an outline.
//
// Requested in review of PR #313: "add tests that cover cases where a
// specimen fails to match over multiple branches where the explanation is an
// outline." The earlier M.or / M.and coverage only exercised branches whose
// alternatives were flat leaves (M.string, M.bigint), so each branch
// contributed exactly one leaf line. These tests exercise the design's
// Example 2 shape — combinator branches whose alternatives are themselves
// compound patterns (splitRecord, arrayOf) — so a single branch's failure
// unrolls into a nested, multi-leaf outline rather than one leaf.

test('M.or over compound alternatives: each branch explanation is a multi-leaf outline (compact)', t => {
  // Design Example 2: three structural alternatives, none matched. Every
  // alternative is a splitRecord, so a branch that fails on more than one
  // field surfaces more than one leaf line under its `alt N` column — the
  // per-branch explanation is an outline, not a single leaf.
  const pattern = M.or(
    M.splitRecord({ kind: 'image', url: M.string() }),
    M.splitRecord({ kind: 'text', body: M.string() }),
    M.splitRecord({ kind: 'embed', target: M.string() }),
  );
  const specimen = harden({ kind: 'image', url: 42 });
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  const lines = text.split('\n');

  t.regex(
    lines[0],
    /or, 3 alternatives, none matched/,
    'header names the disjunction and its arity',
  );

  // alt 0 (kind:"image") fails only on .url — a single-leaf branch.
  const alt0 = lines.filter(l => /^\s*alt 0 \|/.test(l));
  t.is(alt0.length, 1, `alt 0 is a one-leaf branch: ${text}`);
  t.true(alt0[0].includes('.url'), `alt 0 attributes .url: ${text}`);

  // alt 1 (kind:"text") fails on BOTH .body (missing) and .kind (wrong
  // literal): its explanation is a two-leaf outline, each on its own line.
  const alt1 = lines.filter(l => /^\s*alt 1 \|/.test(l));
  t.true(
    alt1.length >= 2,
    `alt 1's explanation is a multi-leaf outline: ${text}`,
  );
  t.true(
    alt1.some(l => l.includes('.body')) && alt1.some(l => l.includes('.kind')),
    `alt 1 outline surfaces both .body and .kind: ${text}`,
  );

  // alt 2 (kind:"embed") likewise fails on .kind and .target.
  const alt2 = lines.filter(l => /^\s*alt 2 \|/.test(l));
  t.true(
    alt2.length >= 2,
    `alt 2's explanation is a multi-leaf outline: ${text}`,
  );
  t.true(
    alt2.some(l => l.includes('.target')),
    `alt 2 outline surfaces .target: ${text}`,
  );

  // Every alt row still carries the found | expected columns.
  for (const row of [...alt0, ...alt1, ...alt2]) {
    t.regex(row, /found .* \| expected /, `alt row keeps its columns: ${row}`);
  }
});

test('M.or over compound alternatives: outline is indented per branch (expanded)', t => {
  const pattern = M.or(
    M.splitRecord({ kind: 'image', url: M.string() }),
    M.splitRecord({ kind: 'text', body: M.string() }),
    M.splitRecord({ kind: 'embed', target: M.string() }),
  );
  const specimen = harden({ kind: 'image', url: 42 });
  const report = explainMismatch({ specimen, pattern }, { format: 'expanded' });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  const lines = text.split('\n');

  t.regex(
    text,
    /or-disjunction, 3 alternatives, none matched/,
    'header names the disjunction',
  );
  t.regex(text, /^\s*alt 0:/m, 'first alternative gets its own outline header');
  t.regex(
    text,
    /^\s*alt 1:/m,
    'second alternative gets its own outline header',
  );
  t.regex(text, /^\s*alt 2:/m, 'third alternative gets its own outline header');

  // The failing branch (alt 1) unrolls into more than one `at .path` section
  // beneath its header — an outline, not a single leaf.
  const alt1Start = lines.findIndex(l => /^\s*alt 1:/.test(l));
  const alt2Start = lines.findIndex(l => /^\s*alt 2:/.test(l));
  t.true(alt1Start >= 0 && alt2Start > alt1Start, 'alt 1 precedes alt 2');
  const alt1Block = lines.slice(alt1Start, alt2Start);
  const alt1Sites = alt1Block.filter(l => /^\s*at \./.test(l));
  t.true(
    alt1Sites.length >= 2,
    `alt 1 unrolls into multiple attribution sites: ${alt1Block.join('\n')}`,
  );
  t.true(
    alt1Block.some(l => /reason:/.test(l)),
    `alt 1 outline carries per-site reasons: ${alt1Block.join('\n')}`,
  );
});

test('M.or over arrayOf alternatives: each branch is a multi-element outline (compact)', t => {
  // A disjunction whose alternatives are element-wise array patterns: the
  // specimen fails every branch, and a branch that rejects more than one
  // element surfaces a multi-line outline of indexed failures.
  const pattern = M.or(M.arrayOf(M.nat()), M.arrayOf(M.string()));
  const specimen = harden([1n, 'two', 3n]); // fails nat at [1]; fails string at [0],[2]
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);
  const lines = text.split('\n');

  t.regex(
    lines[0],
    /or, 2 alternatives, none matched/,
    'header names the disjunction',
  );

  const alt0 = lines.filter(l => /^\s*alt 0 \|/.test(l));
  t.true(
    alt0.some(l => l.includes('[1]')),
    `alt 0 (arrayOf nat) rejects element [1]: ${text}`,
  );

  const alt1 = lines.filter(l => /^\s*alt 1 \|/.test(l));
  t.true(
    alt1.length >= 2,
    `alt 1 (arrayOf string) explanation is a multi-element outline: ${text}`,
  );
  t.true(
    alt1.some(l => l.includes('[0]')) && alt1.some(l => l.includes('[2]')),
    `alt 1 outline surfaces both [0] and [2]: ${text}`,
  );
});

test('M.and over compound branches: branch-indexed nested outline (compact)', t => {
  // A conjunction whose branches are themselves compound: each failing
  // branch descends into its own shape, so the outline carries both the
  // branch index and the nested path (e.g. `(and branch 1).b`).
  const pattern = M.and(
    M.splitRecord({ a: M.string() }),
    M.splitRecord({ b: M.nat() }),
  );
  const specimen = harden({ a: 1, b: -2 }); // fails branch 0 at .a and branch 1 at .b
  const report = explainMismatch({ specimen, pattern });
  t.is(typeof report, 'string');
  const text = /** @type {string} */ (report);

  t.true(
    text.includes('(and branch 0)') && text.includes('(and branch 1)'),
    `both conjunction branches are attributed: ${text}`,
  );
  t.regex(
    text,
    /\(and branch 0\)\.a/,
    'branch 0 outline descends to the nested .a path',
  );
  t.regex(
    text,
    /\(and branch 1\)\.b/,
    'branch 1 outline descends to the nested .b path',
  );
});
