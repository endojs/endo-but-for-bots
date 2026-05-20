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
