// @ts-check
import test from 'ava';

import {
  extractExecCode,
  formatPayload,
  isJsTool,
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

test('tokenizing never loses or reorders source text', t => {
  const source = [
    '// fetch the host',
    "const endo = await E(powers).lookup('endo');",
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
  const typeOf = (source, text) => {
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
