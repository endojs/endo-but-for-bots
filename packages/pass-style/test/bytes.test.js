// @ts-check
// Tests for the passable byte-array utility modules moved from @endo/bytes.
// These modules operate on byteArray-passable values: frozen Uint8Arrays
// backed by immutable ArrayBuffers.
import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';
import { toBytes } from '../src/to-bytes.js';
import { fromBytes } from '../src/from-bytes.js';
import { concatBytes } from '../src/concat-bytes.js';

// ---------------------------------------------------------------------------
// toBytes
// ---------------------------------------------------------------------------

test('toBytes: returns Uint8Array with byteArray passStyle', t => {
  const view = new Uint8Array([1, 2, 3, 4, 5]);
  const immutable = toBytes(view);
  t.true(immutable instanceof Uint8Array);
  t.is(immutable.byteLength, 5);
  // The backing buffer must be an immutable ArrayBuffer.
  t.true(immutable.buffer instanceof ArrayBuffer);
  t.true(/** @type {any} */ (immutable.buffer).immutable);
  t.is(passStyleOf(immutable), 'byteArray');
});

test('toBytes: empty input', t => {
  const immutable = toBytes(new Uint8Array(0));
  t.is(immutable.byteLength, 0);
  t.is(passStyleOf(immutable), 'byteArray');
});

test('toBytes: honors subarray byteOffset and byteLength', t => {
  const full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const window = full.subarray(2, 6); // [2, 3, 4, 5]
  const immutable = toBytes(window);
  t.is(immutable.byteLength, 4);
  t.deepEqual([...fromBytes(immutable)], [2, 3, 4, 5]);
});

test('toBytes: result is hardened (frozen)', t => {
  const result = toBytes(new Uint8Array([10, 20]));
  t.true(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// fromBytes
// ---------------------------------------------------------------------------

test('fromBytes: copies bytes into a fresh Uint8Array', t => {
  const source = new Uint8Array([0, 1, 2, 0xff, 0x80, 0x00, 42, 100]);
  const immutable = toBytes(source);
  const result = fromBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, source.length);
  t.deepEqual([...result], [...source]);
});

test('fromBytes: empty input', t => {
  const immutable = toBytes(new Uint8Array(0));
  const result = fromBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, 0);
});

test('fromBytes: result is a distinct copy (not the same buffer)', t => {
  const source = new Uint8Array([1, 2, 3]);
  const immutable = toBytes(source);
  const mutable = fromBytes(immutable);
  // The result must be a fresh allocation, not the same object.
  t.not(mutable, source);
  t.not(mutable.buffer, immutable.buffer);
  t.deepEqual([...mutable], [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// toBytes + fromBytes round-trip compositions
// ---------------------------------------------------------------------------

test('toBytes + fromBytes: UTF-8 round-trip via TextDecoder', t => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const original = 'Hello, world!';
  const immutable = toBytes(textEncoder.encode(original));
  t.is(textDecoder.decode(fromBytes(immutable)), original);
});

test('toBytes + fromBytes: full byte-range round-trip', t => {
  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    allBytes[i] = i;
  }
  const result = fromBytes(toBytes(allBytes));
  t.deepEqual([...result], [...allBytes]);
});

// ---------------------------------------------------------------------------
// concatBytes
// ---------------------------------------------------------------------------

test('concatBytes: empty input yields empty immutable Uint8Array', t => {
  const result = concatBytes([]);
  t.true(result instanceof Uint8Array);
  t.is(result.byteLength, 0);
  t.is(passStyleOf(result), 'byteArray');
});

test('concatBytes: concatenates multiple immutable buffers byte-for-byte', t => {
  const parts = [
    toBytes(new Uint8Array([1, 2, 3])),
    toBytes(new Uint8Array([])),
    toBytes(new Uint8Array([4])),
    toBytes(new Uint8Array([5, 6, 7, 8])),
  ];
  const result = concatBytes(parts);
  t.is(result.byteLength, 8);
  t.deepEqual([...fromBytes(result)], [1, 2, 3, 4, 5, 6, 7, 8]);
  t.is(passStyleOf(result), 'byteArray');
});

test('concatBytes: result is hardened', t => {
  const parts = [toBytes(new Uint8Array([42]))];
  const result = concatBytes(parts);
  t.true(Object.isFrozen(result));
});

test('concatBytes: single element is equivalent to toBytes of its content', t => {
  const input = new Uint8Array([10, 20, 30]);
  const single = concatBytes([toBytes(input)]);
  t.deepEqual([...fromBytes(single)], [10, 20, 30]);
  t.is(passStyleOf(single), 'byteArray');
});
