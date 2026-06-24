import test from '@endo/ses-ava/test.js';

import { encodeAscii } from '../src/encode.js';
import { decodeAscii } from '../src/decode.js';

test('encodeAscii / decodeAscii: empty string round-trip', t => {
  const bytes = encodeAscii('');
  t.is(bytes.length, 0);
  t.is(decodeAscii(bytes), '');
});

test('encodeAscii / decodeAscii: ASCII round-trip', t => {
  const original = 'Hello, world!';
  const bytes = encodeAscii(original);
  t.is(bytes.length, original.length);
  t.is(decodeAscii(bytes), original);
});

test('encodeAscii: rejects non-ASCII character', t => {
  t.throws(() => encodeAscii('café'), { instanceOf: RangeError });
});

test('encodeAscii: accepts full printable ASCII range', t => {
  const chars = Array.from({ length: 128 }, (_, i) =>
    String.fromCharCode(i),
  ).join('');
  const bytes = encodeAscii(chars);
  t.is(bytes.length, 128);
  t.is(decodeAscii(bytes), chars);
});

test('decodeAscii: passes through byte > 127 without error', t => {
  const bytes = new Uint8Array([0x80]);
  const result = decodeAscii(bytes);
  t.is(result.charCodeAt(0), 0x80);
});

test('encodeAscii returns a plain mutable Uint8Array', t => {
  const bytes = encodeAscii('abc');
  t.true(bytes instanceof Uint8Array);
  // Must be mutable (write succeeds without throwing).
  bytes[0] = 0xff;
  t.is(bytes[0], 0xff);
});
