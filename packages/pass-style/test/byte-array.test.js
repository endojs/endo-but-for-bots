import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '../src/passStyleOf.js';
import {
  byteArrayToUint8Array,
  uint8ArrayToByteArray,
  byteArrayToHex,
  hexToByteArray,
} from '../src/byteArray.js';

test('passStyleOf recognizes immutable ArrayBuffer as byteArray', t => {
  const buf = new ArrayBuffer(4);
  const view = new Uint8Array(buf);
  view[0] = 0xde;
  view[1] = 0xad;
  view[2] = 0xbe;
  view[3] = 0xef;
  const immutable = harden(buf.sliceToImmutable());
  t.is(/** @type {string} */ (passStyleOf(immutable)), 'byteArray');
});

test('passStyleOf byteArray with empty buffer', t => {
  const buf = new ArrayBuffer(0);
  const immutable = harden(buf.sliceToImmutable());
  t.is(/** @type {string} */ (passStyleOf(immutable)), 'byteArray');
});

test('byteArrayToHex / hexToByteArray round-trip', t => {
  const source = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const byteArray = uint8ArrayToByteArray(source);
  t.is(/** @type {string} */ (passStyleOf(byteArray)), 'byteArray');
  const hex = byteArrayToHex(byteArray);
  t.is(hex, 'deadbeef');
  const decoded = hexToByteArray(hex);
  t.is(/** @type {string} */ (passStyleOf(decoded)), 'byteArray');
  t.deepEqual([...byteArrayToUint8Array(decoded)], [...source]);
});

test('empty byteArray round-trip', t => {
  const byteArray = uint8ArrayToByteArray(new Uint8Array(0));
  t.is(byteArrayToHex(byteArray), '');
  const decoded = hexToByteArray('');
  t.is(byteArrayToUint8Array(decoded).length, 0);
});

test('hexToByteArray rejects odd-length input', t => {
  t.throws(() => hexToByteArray('a'), { message: /hex/i });
});

test('uint8ArrayToByteArray honors non-zero byteOffset and byteLength', t => {
  const source = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
  // View into the middle of the buffer: bytes [0x22, 0x33, 0x44].
  const slice = new Uint8Array(source.buffer, 2, 3);
  const byteArray = uint8ArrayToByteArray(slice);
  t.is(byteArrayToHex(byteArray), '223344');
  // subarray() (preserves the underlying buffer with a new offset) should
  // also slice to the visible window only.
  const sub = source.subarray(1, 4);
  t.is(byteArrayToHex(uint8ArrayToByteArray(sub)), '112233');
});
