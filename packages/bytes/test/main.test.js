import test from '@endo/ses-ava/test.js';

import { bytesEqual } from '../src/equals.js';
import { concatBytes } from '../src/concat.js';

test('concatBytes: empty input yields empty Uint8Array', t => {
  const result = concatBytes([]);
  t.true(result instanceof Uint8Array);
  t.is(result.length, 0);
});

test('concatBytes: single chunk preserves bytes', t => {
  const a = new Uint8Array([1, 2, 3]);
  const result = concatBytes([a]);
  t.deepEqual([...result], [1, 2, 3]);
});

test('concatBytes: many small chunks preserves order', t => {
  const chunks = [
    new Uint8Array([1]),
    new Uint8Array([2, 3]),
    new Uint8Array([4, 5, 6]),
    new Uint8Array([7]),
  ];
  const result = concatBytes(chunks);
  t.deepEqual([...result], [1, 2, 3, 4, 5, 6, 7]);
});

test('concatBytes: zero-length chunks interleaved with non-empty', t => {
  const chunks = [
    new Uint8Array([]),
    new Uint8Array([1, 2]),
    new Uint8Array([]),
    new Uint8Array([3]),
    new Uint8Array([]),
  ];
  const result = concatBytes(chunks);
  t.deepEqual([...result], [1, 2, 3]);
});

test('concatBytes: lengths around 64-byte boundaries', t => {
  // Catches any future SIMD optimization that assumes alignment.
  for (const len of [63, 64, 65, 127, 128, 129]) {
    const chunk = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      chunk[i] = i % 256;
    }
    const result = concatBytes([chunk, chunk]);
    t.is(result.length, len * 2);
    for (let i = 0; i < len; i += 1) {
      t.is(result[i], i % 256);
      t.is(result[i + len], i % 256);
    }
  }
});

test('concatBytes: huge chunk plus zero-length chunks', t => {
  const big = new Uint8Array(4096);
  for (let i = 0; i < big.length; i += 1) {
    big[i] = i % 256;
  }
  const result = concatBytes([new Uint8Array([]), big, new Uint8Array([])]);
  t.is(result.length, 4096);
  for (let i = 0; i < 4096; i += 1) {
    t.is(result[i], i % 256);
  }
});

test('bytesEqual: identical reference', t => {
  const a = new Uint8Array([1, 2, 3]);
  t.true(bytesEqual(a, a));
});

test('bytesEqual: identical contents different references', t => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  t.true(bytesEqual(a, b));
});

test('bytesEqual: different lengths', t => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2]);
  t.false(bytesEqual(a, b));
});

test('bytesEqual: same prefix different suffix', t => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 5]);
  t.false(bytesEqual(a, b));
});

test('bytesEqual: empty arrays compare equal', t => {
  t.true(bytesEqual(new Uint8Array(), new Uint8Array()));
});

test('bytesEqual: differs at first byte', t => {
  const a = new Uint8Array([0, 1, 2]);
  const b = new Uint8Array([1, 1, 2]);
  t.false(bytesEqual(a, b));
});
