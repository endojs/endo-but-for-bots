// @ts-check

import test from 'ava';
import { encodeHex, decodeHex, toHex, fromHex } from '../index.js';
import { jsEncodeHex } from '../src/encode.js';
import { jsDecodeHex } from '../src/decode.js';

test('round-trip across the full byte space', t => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    all[i] = i;
  }
  const hex = encodeHex(all);
  t.is(hex.length, 512);
  t.is(hex.slice(0, 6), '000102');
  t.is(hex.slice(-6), 'fdfeff');
  const back = decodeHex(hex);
  t.is(back.length, 256);
  for (let i = 0; i < 256; i += 1) {
    t.is(back[i], i);
  }
});

test('encodeHex is lowercase by default', t => {
  t.is(encodeHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), 'deadbeef');
});

test('encodeHex uppercase option', t => {
  t.is(
    encodeHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { uppercase: true }),
    'DEADBEEF',
  );
});

test('decodeHex accepts both cases', t => {
  const lower = decodeHex('deadbeef');
  const upper = decodeHex('DEADBEEF');
  const mixed = decodeHex('DeAdBeEf');
  t.deepEqual([...lower], [0xde, 0xad, 0xbe, 0xef]);
  t.deepEqual([...upper], [0xde, 0xad, 0xbe, 0xef]);
  t.deepEqual([...mixed], [0xde, 0xad, 0xbe, 0xef]);
});

test('empty input round-trip', t => {
  t.is(encodeHex(new Uint8Array([])), '');
  t.is(decodeHex('').length, 0);
});

test('decodeHex rejects odd-length input', t => {
  t.throws(() => decodeHex('a'), { message: /hex/i });
  t.throws(() => decodeHex('abc'), { message: /hex/i });
});

test('decodeHex rejects invalid characters', t => {
  t.throws(() => decodeHex('gg'), { message: /hex/i });
  t.throws(() => decodeHex('0z'), { message: /hex/i });
  t.throws(() => decodeHex(' 0a'), { message: /hex/i });
});

test('decodeHex embeds the provided name in error messages', t => {
  t.throws(() => decodeHex('a', 'myInput'), { message: /myInput/ });
  t.throws(() => decodeHex('gg', 'another'), { message: /another/ });
});

test('jsEncodeHex round-trips through jsDecodeHex', t => {
  const inputs = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([255]),
    new Uint8Array([1, 2, 3, 4, 5]),
    new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
  ];
  for (const bytes of inputs) {
    const hex = jsEncodeHex(bytes);
    const back = jsDecodeHex(hex);
    t.deepEqual([...back], [...bytes]);
  }
});

test('dispatched and polyfill encode agree on clean inputs', t => {
  const inputs = [
    new Uint8Array([]),
    new Uint8Array([0, 1, 2]),
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  ];
  for (const bytes of inputs) {
    t.is(encodeHex(bytes), jsEncodeHex(bytes));
  }
});

test('dispatched and polyfill decode agree on clean inputs', t => {
  const inputs = ['', '000102', 'deadbeef', 'CAFEBABE'];
  for (const hex of inputs) {
    t.deepEqual([...decodeHex(hex)], [...jsDecodeHex(hex)]);
  }
});

test('toHex is an alias of encodeHex', t => {
  t.is(toHex, encodeHex);
  t.is(toHex(new Uint8Array([0xde, 0xad])), 'dead');
});

test('fromHex is an alias of decodeHex', t => {
  t.is(fromHex, decodeHex);
  t.deepEqual([...fromHex('dead')], [0xde, 0xad]);
});
