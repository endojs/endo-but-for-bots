// @ts-nocheck

import test from 'ava';

import { encodeAscii } from '../index.js';
import { encodeAscii as encodeAsciiFromSubpath } from '../encode.js';

test('encodes ASCII text to its code-unit bytes', t => {
  t.deepEqual(encodeAscii(''), new Uint8Array());
  t.deepEqual(encodeAscii('abc'), Uint8Array.of(0x61, 0x62, 0x63));
  t.deepEqual(
    encodeAscii('Hello, world!'),
    Uint8Array.of(
      0x48,
      0x65,
      0x6c,
      0x6c,
      0x6f,
      0x2c,
      0x20,
      0x77,
      0x6f,
      0x72,
      0x6c,
      0x64,
      0x21,
    ),
  );
});

test('admits the full 7-bit range, including NUL and DEL', t => {
  const all = Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(i));
  const text = all.join('');
  const bytes = encodeAscii(text);
  t.is(bytes.length, 0x80);
  for (let i = 0; i < 0x80; i += 1) {
    t.is(bytes[i], i);
  }
  // The boundary code units specifically.
  t.deepEqual(encodeAscii('\x00'), Uint8Array.of(0x00));
  t.deepEqual(encodeAscii('\x7f'), Uint8Array.of(0x7f));
});

test('rejects a code unit at the 0x80 boundary', t => {
  t.throws(() => encodeAscii('\x80'), { instanceOf: RangeError });
});

test('rejects Latin-1 and other non-ASCII text, reporting the offset', t => {
  // é is U+00E9, the first character past the 7-bit range.
  const error = t.throws(() => encodeAscii('café'), { instanceOf: RangeError });
  t.regex(error.message, /0xe9/);
  t.regex(error.message, /offset 3/);
});

test('rejects a surrogate half of a non-BMP code point', t => {
  // U+1F600 is the pair D83D DE00; each half is well past 0x7f.
  t.throws(() => encodeAscii('a😀'), { instanceOf: RangeError });
});

test('names the string in the diagnostic when asked', t => {
  const error = t.throws(() => encodeAscii('ÿ', 'greeting'), {
    instanceOf: RangeError,
  });
  t.regex(error.message, /string greeting/);
});

test('rejects a non-string input', t => {
  // @ts-expect-error exercising the runtime contract
  t.throws(() => encodeAscii(0x41), { instanceOf: TypeError });
  // @ts-expect-error exercising the runtime contract
  t.throws(() => encodeAscii(Uint8Array.of(0x41)), { instanceOf: TypeError });
});

test('the package entry and the encode.js subpath export the same function', t => {
  t.is(encodeAscii, encodeAsciiFromSubpath);
});
