// @ts-check
// Tests for the passable byte-array utility modules moved from @endo/bytes.
// These modules operate on byteArray-passable values: frozen Uint8Arrays
// backed by immutable ArrayBuffers.
import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';
import { frozenBytes } from '../src/to-bytes.js';
import { thawnBytes } from '../src/from-bytes.js';
import { concatBytes } from '../src/concat-bytes.js';
import { decodeUtf8 } from '../src/decode-utf8.js';
import { strictDecodeUtf8 } from '../src/strict-decode-utf8.js';

// ---------------------------------------------------------------------------
// frozenBytes
// ---------------------------------------------------------------------------

test('frozenBytes: returns Uint8Array with byteArray passStyle', t => {
  const view = new Uint8Array([1, 2, 3, 4, 5]);
  const immutable = frozenBytes(view);
  t.true(immutable instanceof Uint8Array);
  t.is(immutable.byteLength, 5);
  // The backing buffer must be an immutable ArrayBuffer.
  t.true(immutable.buffer instanceof ArrayBuffer);
  t.true(/** @type {any} */ (immutable.buffer).immutable);
  t.is(passStyleOf(immutable), 'byteArray');
});

test('frozenBytes: empty input', t => {
  const immutable = frozenBytes(new Uint8Array(0));
  t.is(immutable.byteLength, 0);
  t.is(passStyleOf(immutable), 'byteArray');
});

test('frozenBytes: honors subarray byteOffset and byteLength', t => {
  const full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const window = full.subarray(2, 6); // [2, 3, 4, 5]
  const immutable = frozenBytes(window);
  t.is(immutable.byteLength, 4);
  t.deepEqual([...thawnBytes(immutable)], [2, 3, 4, 5]);
});

test('frozenBytes: result is hardened (frozen)', t => {
  const result = frozenBytes(new Uint8Array([10, 20]));
  t.true(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// thawnBytes
// ---------------------------------------------------------------------------

test('thawnBytes: copies bytes into a fresh Uint8Array', t => {
  const source = new Uint8Array([0, 1, 2, 0xff, 0x80, 0x00, 42, 100]);
  const immutable = frozenBytes(source);
  const result = thawnBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, source.length);
  t.deepEqual([...result], [...source]);
});

test('thawnBytes: empty input', t => {
  const immutable = frozenBytes(new Uint8Array(0));
  const result = thawnBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, 0);
});

test('thawnBytes: result is a distinct copy (not the same buffer)', t => {
  const source = new Uint8Array([1, 2, 3]);
  const immutable = frozenBytes(source);
  const mutable = thawnBytes(immutable);
  // The result must be a fresh allocation, not the same object.
  t.not(mutable, source);
  t.not(mutable.buffer, immutable.buffer);
  t.deepEqual([...mutable], [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// frozenBytes + thawnBytes round-trip compositions
// ---------------------------------------------------------------------------

test('frozenBytes + thawnBytes: UTF-8 round-trip via TextDecoder', t => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const original = 'Hello, world!';
  const immutable = frozenBytes(textEncoder.encode(original));
  t.is(textDecoder.decode(thawnBytes(immutable)), original);
});

test('frozenBytes + thawnBytes: full byte-range round-trip', t => {
  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    allBytes[i] = i;
  }
  const result = thawnBytes(frozenBytes(allBytes));
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
    frozenBytes(new Uint8Array([1, 2, 3])),
    frozenBytes(new Uint8Array([])),
    frozenBytes(new Uint8Array([4])),
    frozenBytes(new Uint8Array([5, 6, 7, 8])),
  ];
  const result = concatBytes(parts);
  t.is(result.byteLength, 8);
  t.deepEqual([...thawnBytes(result)], [1, 2, 3, 4, 5, 6, 7, 8]);
  t.is(passStyleOf(result), 'byteArray');
});

test('concatBytes: result is hardened', t => {
  const parts = [frozenBytes(new Uint8Array([42]))];
  const result = concatBytes(parts);
  t.true(Object.isFrozen(result));
});

test('concatBytes: single element is equivalent to frozenBytes of its content', t => {
  const input = new Uint8Array([10, 20, 30]);
  const single = concatBytes([frozenBytes(input)]);
  t.deepEqual([...thawnBytes(single)], [10, 20, 30]);
  t.is(passStyleOf(single), 'byteArray');
});

// ---------------------------------------------------------------------------
// decodeUtf8 / strictDecodeUtf8 with passable (shimmed) byteArrays
// ---------------------------------------------------------------------------

test('decodeUtf8: decodes a passable byteArray (shimmed frozen Uint8Array) to a string', t => {
  // frozenBytes produces a frozen Uint8Array backed by an immutable
  // ArrayBuffer (via the @endo/immutable-arraybuffer shim).
  // TextDecoder.decode rejects such views; decodeUtf8 must copy internally.
  const encoded = new TextEncoder().encode('Hello, world!');
  const passable = frozenBytes(encoded);
  t.is(passStyleOf(passable), 'byteArray');
  t.is(decodeUtf8(passable), 'Hello, world!');
});

test('decodeUtf8: substitutes U+FFFD for malformed sequences in a passable byteArray', t => {
  const invalid = frozenBytes(new Uint8Array([0x80]));
  t.is(passStyleOf(invalid), 'byteArray');
  // U+FFFD replacement character (lenient decode)
  t.is(decodeUtf8(invalid), '�');
});

test('strictDecodeUtf8: decodes a valid passable byteArray to a string', t => {
  const encoded = new TextEncoder().encode('strict test');
  const passable = frozenBytes(encoded);
  t.is(passStyleOf(passable), 'byteArray');
  t.is(strictDecodeUtf8(passable), 'strict test');
});

test('strictDecodeUtf8: throws on malformed sequence in a passable byteArray', t => {
  const invalid = frozenBytes(new Uint8Array([0x80]));
  t.is(passStyleOf(invalid), 'byteArray');
  t.throws(() => strictDecodeUtf8(invalid), { instanceOf: TypeError });
});
