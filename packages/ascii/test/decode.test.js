// @ts-nocheck

import test from 'ava';

import { decodeAscii, encodeAscii } from '../index.js';
import { decodeAscii as decodeAsciiFromSubpath } from '../decode.js';

test('decodes code-unit bytes to their ASCII text', t => {
  t.is(decodeAscii(new Uint8Array()), '');
  t.is(decodeAscii(Uint8Array.of(0x61, 0x62, 0x63)), 'abc');
  t.is(
    decodeAscii(
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
    ),
    'Hello, world!',
  );
});

test('admits the full 7-bit range, including NUL and DEL', t => {
  const bytes = new Uint8Array(0x80);
  for (let i = 0; i < 0x80; i += 1) {
    bytes[i] = i;
  }
  const text = decodeAscii(bytes);
  t.is(text.length, 0x80);
  for (let i = 0; i < 0x80; i += 1) {
    t.is(text.charCodeAt(i), i);
  }
  // The boundary bytes specifically.
  t.is(decodeAscii(Uint8Array.of(0x00)), '\x00');
  t.is(decodeAscii(Uint8Array.of(0x7f)), '\x7f');
});

test('rejects a byte at the 0x80 boundary, reporting the offset', t => {
  const error = t.throws(() => decodeAscii(Uint8Array.of(0x61, 0x80)), {
    instanceOf: RangeError,
  });
  t.regex(error.message, /0x80/);
  t.regex(error.message, /offset 1/);
});

test('rejects every non-ASCII byte 0x80-0xff', t => {
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    t.throws(() => decodeAscii(Uint8Array.of(byte)), {
      instanceOf: RangeError,
    });
  }
});

test('names the bytes in the diagnostic when asked', t => {
  const error = t.throws(() => decodeAscii(Uint8Array.of(0xff), 'greeting'), {
    instanceOf: RangeError,
  });
  t.regex(error.message, /bytes greeting/);
});

test('rejects a non-Uint8Array input', t => {
  t.throws(() => decodeAscii('abc'), { instanceOf: TypeError });
  t.throws(() => decodeAscii([0x41]), { instanceOf: TypeError });
});

test('reads the intrinsic Uint8Array length and rejects proxies', t => {
  class MisleadingLength extends Uint8Array {
    // eslint-disable-next-line class-methods-use-this
    get length() {
      return 4;
    }
  }

  t.is(decodeAscii(new MisleadingLength([0x41])), 'A');
  t.throws(() => decodeAscii(new Proxy(Uint8Array.of(0x41), {})), {
    instanceOf: TypeError,
  });
});

test('rejects a Uint8Array over a detached buffer', t => {
  const bytes = Uint8Array.of(0x41);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  t.throws(() => decodeAscii(bytes), { instanceOf: TypeError });
});

test('round-trips with encodeAscii across the full admitted range', t => {
  let text = '';
  for (let i = 0; i < 0x80; i += 1) {
    text += String.fromCharCode(i);
  }
  t.is(decodeAscii(encodeAscii(text)), text);
});

test('round-trips inputs longer than the code-unit chunk size', t => {
  let text = '';
  for (let index = 0; index < 4096 * 2 + 1; index += 1) {
    text += String.fromCharCode(index % 0x80);
  }
  t.is(decodeAscii(encodeAscii(text)), text);
});

test('the package entry and the decode.js subpath export the same function', t => {
  t.is(decodeAscii, decodeAsciiFromSubpath);
});
