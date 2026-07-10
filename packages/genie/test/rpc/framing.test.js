// @ts-check

/**
 * Tests for the strict LF-delimited JSON framing codec.
 *
 * These lock in the Pi framing rule the bridge depends on: split on `\n`
 * and nothing else. Each test is written to fail if the decoder regressed
 * to `readline`-style behaviour (splitting on `\r` / `U+2028` / `U+2029`)
 * or dropped a buffered partial line.
 */

import '@endo/harden';

import test from 'ava';

import { encodeRecord, makeJsonlDecoder } from '../../src/rpc/framing.js';

test('push — a single complete line yields one record', t => {
  const decoder = makeJsonlDecoder();
  const lines = decoder.push('{"type":"prompt"}\n');
  t.deepEqual(lines, ['{"type":"prompt"}']);
  t.deepEqual(JSON.parse(lines[0]), { type: 'prompt' });
});

test('push — multiple lines in one chunk split into records', t => {
  const decoder = makeJsonlDecoder();
  const lines = decoder.push('{"a":1}\n{"b":2}\n{"c":3}\n');
  t.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('push — a partial line is buffered across chunks', t => {
  const decoder = makeJsonlDecoder();
  t.deepEqual(decoder.push('{"a":'), []);
  t.deepEqual(decoder.push('1}\n'), ['{"a":1}']);
});

test('push — does not split on a bare carriage return', t => {
  const decoder = makeJsonlDecoder();
  // A CRLF sender: the `\r` must stay attached to the line, not split it.
  const lines = decoder.push('{"a":1}\r\n{"b":2}\n');
  t.deepEqual(lines, ['{"a":1}\r', '{"b":2}']);
  t.true(lines[0].endsWith('\r'));
  // Trailing `\r` is JSON whitespace, so the record still parses.
  t.deepEqual(JSON.parse(lines[0]), { a: 1 });
});

test('push — does not split on U+2028 or U+2029', t => {
  const decoder = makeJsonlDecoder();
  // The line separator U+2028 and paragraph separator U+2029 are ordinary
  // characters inside a record; only a line feed ends it.
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  const lines = decoder.push(`"a${ls}b${ps}c"\nrest`);
  t.deepEqual(lines, [`"a${ls}b${ps}c"`]);
  t.true(lines[0].includes(ls));
  t.true(lines[0].includes(ps));
  // The unterminated remainder stays buffered until its own line feed.
  t.deepEqual(decoder.push('\n'), ['rest']);
});

test('push — accepts byte chunks and decodes UTF-8', t => {
  const decoder = makeJsonlDecoder();
  const bytes = new TextEncoder().encode('{"s":"hi"}\n');
  t.deepEqual(decoder.push(bytes), ['{"s":"hi"}']);
});

test('push — reassembles a multibyte character split across chunks', t => {
  const decoder = makeJsonlDecoder();
  const bytes = new TextEncoder().encode('{"c":"€"}\n'); // U+20AC is 3 UTF-8 bytes
  const first = bytes.slice(0, 8);
  const second = bytes.slice(8);
  t.deepEqual(decoder.push(first), []);
  t.deepEqual(decoder.push(second), ['{"c":"€"}']);
});

test('flush — surfaces a trailing unterminated line', t => {
  const decoder = makeJsonlDecoder();
  t.deepEqual(decoder.push('{"a":1}'), []);
  t.deepEqual(decoder.flush(), ['{"a":1}']);
  // A second flush with nothing buffered yields nothing.
  t.deepEqual(decoder.flush(), []);
});

test('push — preserves an empty line between two newlines', t => {
  const decoder = makeJsonlDecoder();
  t.deepEqual(decoder.push('{"a":1}\n\n{"b":2}\n'), ['{"a":1}', '', '{"b":2}']);
});

test('encodeRecord — appends exactly one trailing newline and round-trips', t => {
  const line = encodeRecord({ type: 'agent_end', id: '7' });
  t.is(line, '{"type":"agent_end","id":"7"}\n');
  t.is(line.endsWith('\n'), true);
  t.is(line.slice(0, -1).includes('\n'), false);
  t.deepEqual(JSON.parse(line), { type: 'agent_end', id: '7' });
});
