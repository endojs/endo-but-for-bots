import test from '@endo/ses-ava/test.js';

import { encodeUtf8 } from '../src/encode.js';
import { decodeUtf8 } from '../src/decode.js';
import { strictDecodeUtf8 } from '../src/strict-decode.js';

test('encodeUtf8 / decodeUtf8: empty string round-trip', t => {
  const bytes = encodeUtf8('');
  t.is(bytes.length, 0);
  t.is(decodeUtf8(bytes), '');
});

test('encodeUtf8 / decodeUtf8: ASCII round-trip', t => {
  const original = 'Hello, world!';
  const bytes = encodeUtf8(original);
  t.is(bytes.length, original.length);
  t.is(decodeUtf8(bytes), original);
});

test('encodeUtf8: BMP multi-byte UTF-8', t => {
  // U+00E9 (eacute) encodes to two bytes; U+4E2D (Chinese middle)
  // encodes to three bytes.
  const bytes = encodeUtf8('é中');
  t.deepEqual([...bytes], [0xc3, 0xa9, 0xe4, 0xb8, 0xad]);
  t.is(decodeUtf8(bytes), 'é中');
});

test('encodeUtf8: non-BMP UTF-8 (surrogate pair)', t => {
  // U+1F600 requires a surrogate pair in UTF-16 and four bytes in UTF-8.
  const bytes = encodeUtf8('\u{1F600}');
  t.deepEqual([...bytes], [0xf0, 0x9f, 0x98, 0x80]);
  t.is(decodeUtf8(bytes), '\u{1F600}');
});

test('decodeUtf8: substitutes U+FFFD on invalid UTF-8', t => {
  // 0xC3 begins a two-byte sequence; 0x28 is not a valid continuation byte.
  const invalid = new Uint8Array([0xc3, 0x28]);
  const result = decodeUtf8(invalid);
  t.true(result.includes('�'));
});

test('strictDecodeUtf8: accepts valid UTF-8', t => {
  const bytes = encodeUtf8('Hello, world! \u{1F600}');
  t.is(strictDecodeUtf8(bytes), 'Hello, world! \u{1F600}');
});

test('strictDecodeUtf8: throws on invalid UTF-8', t => {
  // 0xC3 begins a two-byte sequence; 0x28 is not a valid continuation byte.
  const invalid = new Uint8Array([0xc3, 0x28]);
  t.throws(() => strictDecodeUtf8(invalid), { instanceOf: TypeError });
});

test('encodeUtf8 returns a plain mutable Uint8Array', t => {
  const bytes = encodeUtf8('abc');
  t.true(bytes instanceof Uint8Array);
  // Must be mutable (write succeeds without throwing).
  bytes[0] = 0xff;
  t.is(bytes[0], 0xff);
});
