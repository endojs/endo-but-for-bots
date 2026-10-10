// @ts-check
import test from 'ava';

import {
  extractExecCode,
  formatPayload,
  isJsTool,
  projectTranscript,
  summarizeActions,
} from '../src/MessageList.js';
import { tokenizeJs } from '../src/highlight.js';

test('exec and its MCP aliases are recognised as JavaScript tools', t => {
  t.true(isJsTool('exec'));
  t.true(isJsTool('mcp__endo__exec'));
  t.true(isJsTool('mcp__other__exec'));
  t.false(isJsTool('mcp__endo__list'));
  t.false(isJsTool('execute'));
  t.false(isJsTool(undefined));
});

test('exec args unwrap to the JavaScript body', t => {
  const args = JSON.stringify({ code: 'const x = 1;\nreturn x;' });
  t.is(extractExecCode(args), 'const x = 1;\nreturn x;');
});

test('exec args that are not the expected shape are shown verbatim', t => {
  t.is(extractExecCode('not json at all'), 'not json at all');
  t.is(extractExecCode('{"petName":"endo"}'), '{"petName":"endo"}');
  t.is(extractExecCode(undefined), '');
});

test('JSON payloads are pretty-printed and other text is left alone', t => {
  t.is(formatPayload('{"a":1}'), '{\n  "a": 1\n}');
  t.is(formatPayload('[1,2]'), '[\n  1,\n  2\n]');
  t.is(formatPayload('plain text'), 'plain text');
  t.is(formatPayload('{ broken'), '{ broken');
  t.is(formatPayload(null), '');
});

test('a run of actions summarises as a total plus a per-tool tally', t => {
  const summary = summarizeActions([
    { role: 'tool', name: 'exec' },
    { role: 'tool', name: 'exec' },
    { role: 'tool', name: 'list' },
  ]);
  t.is(summary.total, 3);
  t.is(summary.label, '3 actions');
  t.is(summary.detail, 'exec ×2, list');
  t.deepEqual(summary.counts, [
    { name: 'exec', count: 2 },
    { name: 'list', count: 1 },
  ]);
});

test('a single unnamed action still summarises', t => {
  const summary = summarizeActions([{ role: 'tool' }]);
  t.is(summary.label, '1 action');
  t.is(summary.detail, 'tool');
});

test('consecutive actions group into one collapsible run', t => {
  const { rows, pending } = projectTranscript([
    { role: 'user', text: 'do it' },
    { role: 'tool', name: 'exec' },
    { role: 'tool', name: 'list' },
    { role: 'assistant', text: 'done' },
    { role: 'tool', name: 'exec' },
  ]);
  t.deepEqual(pending, []);
  t.deepEqual(
    rows.map(row => (row.kind === 'actions' ? row.actions.length : row.kind)),
    ['bubble', 2, 'bubble', 1],
    'each run between replies is one group, and replies stay separate rows',
  );
  // `index` is what keys the row. Preact reuses a row across re-renders by its
  // key, so a collision collapses whichever group the reader had open.
  t.deepEqual(
    rows.map(row => row.index),
    [0, 1, 3, 4],
    'each row is keyed by where it starts in the snapshot',
  );
});

test('queued submissions are lifted out of the transcript in order', t => {
  const { rows, pending } = projectTranscript([
    { role: 'user', text: 'first' },
    { role: 'user', text: 'queued A', pending: true, pendingId: 1 },
    { role: 'user', text: 'queued B', pending: true, pendingId: 2 },
  ]);
  t.is(rows.length, 1, 'only the sent message stays in the transcript');
  t.deepEqual(
    pending.map(msg => msg.pendingId),
    [1, 2],
    'queued messages keep the order they will run in',
  );
});

test('a pending message without an id renders as an ordinary bubble', t => {
  // Its buttons would address nobody, and every such row would key to
  // `pending-undefined` — one Preact instance shared between them, so editing
  // one would rewrite the other.
  const { rows, pending } = projectTranscript([
    { role: 'user', text: 'no id', pending: true },
  ]);
  t.deepEqual(pending, []);
  t.is(rows.length, 1);
  t.is(rows[0].kind, 'bubble');
});

test('tokenizing never loses or reorders source text', t => {
  const source = [
    '// fetch the host',
    "const endo = await E(powers).lookup('endo');",
    // Fixtures are JavaScript source, so `${…}` here is the subject under test.
    // eslint-disable-next-line no-template-curly-in-string
    'const names = /^@/.test(x) ? 1_000 : `n=${x}`;',
    '/* done */',
  ].join('\n');
  t.is(
    tokenizeJs(source)
      .map(tok => tok.text)
      .join(''),
    source,
  );
});

test('tokenizing classifies the pieces an exec body is made of', t => {
  const typeOf = (/** @type {string} */ source, /** @type {string} */ text) => {
    const found = tokenizeJs(source).find(tok => tok.text === text);
    return found && found.type;
  };
  const source = "const x = await f('s'); // note";
  t.is(typeOf(source, 'const'), 'keyword');
  t.is(typeOf(source, 'await'), 'keyword');
  t.is(typeOf(source, 'x'), 'identifier');
  t.is(typeOf(source, "'s'"), 'string');
  t.is(typeOf(source, '// note'), 'comment');
  t.is(typeOf('const n = 42;', '42'), 'number');
  t.is(typeOf('const t = true;', 'true'), 'literal');
  t.is(typeOf('const r = /ab+c/g;', '/ab+c/g'), 'regexp');
  // eslint-disable-next-line no-template-curly-in-string
  t.is(typeOf('const s = `a${b}`;', '`a${b}`'), 'template');
});

test('division is not mistaken for a regular expression', t => {
  const tokens = tokenizeJs('const half = total / 2;');
  const slash = tokens.find(tok => tok.text === '/');
  t.is(slash && slash.type, 'punctuation');
  t.false(tokens.some(tok => tok.type === 'regexp'));
});

test('an unterminated string stops at the end of its line', t => {
  const source = "const a = 'oops\nconst b = 2;";
  const tokens = tokenizeJs(source);
  t.is(
    tokens.map(tok => tok.text).join(''),
    source,
    'text is preserved even when the string never closes',
  );
  const b = tokens.find(tok => tok.text === 'b');
  t.is(b && b.type, 'identifier', 'the next line still tokenizes normally');
});

test('an unterminated block comment and regex still reproduce their source', t => {
  for (const source of ['/* never closed', 'const r = /unclosed;', 'x = `a']) {
    t.is(
      tokenizeJs(source)
        .map(tok => tok.text)
        .join(''),
      source,
      source,
    );
  }
});

// Sources chosen to reach every branch of the scanner, including the ones that
// only a malformed snippet reaches. An `exec` body is model output: it can be
// anything.
const ADVERSARIAL = Object.freeze([
  '',
  ' ',
  '\n\r\t',
  '/',
  '//',
  '/*',
  '/**/',
  '*/',
  '`',
  '"',
  "'",
  '\\',
  "'a\\",
  '`a\\',
  '/a\\',
  '"unterminated',
  '`multi\nline`',
  '/[/]/g',
  '/[unclosed',
  '=/[',
  '=/['.repeat(200),
  'a / b / c',
  'if (a) /re/.test(b)',
  'return /re/;',
  '1e+5',
  '1e',
  '.5',
  '1..toString()',
  '0x1F + 0b11 + 0o7 + 1_000n',
  '5-3',
  '#!/usr/bin/env node',
  '\0\u{1F600}\uD800',
  '@#$%^&*',
  'const x = {a: 1}; // done',
]);

test('every token carries text, so the scanner always advances', t => {
  // A scan that returned its own start would loop forever, and the round-trip
  // check alone cannot see it: slicing [i, i) yields '', which joins invisibly.
  // Bounded so a regression fails here rather than parking on AVA's timeout.
  t.timeout(5000);
  for (const source of ADVERSARIAL) {
    const tokens = tokenizeJs(source);
    t.true(
      tokens.every(tok => tok.text.length > 0),
      `empty token in ${JSON.stringify(source)}`,
    );
    t.is(
      tokens.map(tok => tok.text).join(''),
      source,
      `round trip for ${JSON.stringify(source)}`,
    );
  }
});

test('a line of unclosed regex literals does not go quadratic', t => {
  // `scanRegExp` runs to the end of the line before giving up, so without
  // remembering that failure every later slash rescans the same tail. This view
  // renders model output and cannot yield, so the cost is a frozen tab.
  t.timeout(5000);
  const source = '=/['.repeat(20_000);
  const started = Date.now();
  const tokens = tokenizeJs(source);
  t.is(tokens.map(tok => tok.text).join(''), source);
  t.true(
    Date.now() - started < 2000,
    `60KB of unclosed literals took ${Date.now() - started}ms`,
  );
});

test('escapes, exponents and character classes are scanned, not skimmed', t => {
  const typeOf = (/** @type {string} */ source, /** @type {string} */ text) => {
    const found = tokenizeJs(source).find(tok => tok.text === text);
    return found && found.type;
  };
  // A quote escaped inside a string does not end it.
  t.is(typeOf("x = 'a\\'b' + c", "'a\\'b'"), 'string');
  // Nor does a slash escaped inside a regex, nor one inside a character class.
  t.is(typeOf('x = /a\\/b/;', '/a\\/b/'), 'regexp');
  t.is(typeOf('x = /[/]/g;', '/[/]/g'), 'regexp');
  // `+` continues a number only as an exponent sign.
  t.is(typeOf('n = 1e+5;', '1e+5'), 'number');
  t.is(typeOf('n = 5-3;', '5'), 'number');
  t.is(typeOf('n = 5-3;', '-'), 'punctuation');
  t.is(typeOf('n = .5;', '.5'), 'number');
  // A block comment ends at its own `*/`, not one character either side.
  t.is(typeOf('/* a */ b', '/* a */'), 'comment');
  t.is(typeOf('/* a */ b', 'b'), 'identifier');
  // A regex is possible where a value is expected, and not after one. A closing
  // bracket ends a value, so division after it must not swallow the rest of the
  // line as a literal — which needs a second slash on the line to detect, since
  // an unclosed scan falls back to punctuation on its own.
  t.is(typeOf('/re/.test(x)', '/re/'), 'regexp');
  t.is(typeOf('return /re/;', '/re/'), 'regexp');
  t.is(typeOf('a / b', '/'), 'punctuation');
  t.is(typeOf('f(a) / b / c', '/'), 'punctuation');
  t.is(typeOf('xs[0] / b / c', '/'), 'punctuation');
  t.is(typeOf('{a} / b / c', '/'), 'punctuation');
});
