import test from 'ava';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

import { bytesEqual } from '../src/equals.js';
import { compareBytes } from '../src/compare.js';
import { constantTimeBytesEqual } from '../src/constant-time-equals.js';
import { concatBytes } from '../src/concat.js';
import { concatImmutables } from '../src/concat-immutables.js';

// Under a native immutable ArrayBuffer implementation (e.g. current XS), the
// `@endo/immutable-arraybuffer` shim steps aside (stage-3 detect-then-skip), so
// `frozenBytes(...)` yields a GENUINE view: `ArrayBuffer.isView === true` and
// integer-indexable in place. The two emulated-wrapper fidelity assertions
// below (isView false; direct integer-indexed read `undefined`) describe the
// shim path specifically, so they are gated to run under the shim and skip
// under native — rather than baking in the (now obsolete) assumption that no
// engine ships native support. See endojs/endo-but-for-bots#475 (erights
// review). The `compareBytes`/`bytesEqual` byte-value assertions elsewhere in
// this file hold on both paths and stay unguarded.
const emulatedOnlyTest = ArrayBuffer.isView(frozenBytes(new Uint8Array([0])))
  ? test.skip
  : test;

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

test('constantTimeBytesEqual compares byte arrays', t => {
  t.true(
    constantTimeBytesEqual(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
    ),
  );
  t.false(
    constantTimeBytesEqual(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 4]),
    ),
  );
  t.false(constantTimeBytesEqual(new Uint8Array([1]), new Uint8Array([1, 0])));
});

test('constantTimeBytesEqual compares emulated byteArray wrappers', t => {
  const left = frozenBytes(new Uint8Array([1, 2, 3]));
  const equal = frozenBytes(new Uint8Array([1, 2, 3]));
  const different = frozenBytes(new Uint8Array([1, 2, 4]));
  t.true(constantTimeBytesEqual(left, equal));
  t.false(constantTimeBytesEqual(left, different));
});

test('frozenBytes: returns immutable Uint8Array', t => {
  const view = new Uint8Array([1, 2, 3, 4, 5]);
  const immutable = frozenBytes(view);
  t.true(immutable instanceof Uint8Array);
  t.is(immutable.byteLength, 5);
  // The backing buffer is an immutable ArrayBuffer.
  t.true(immutable.buffer instanceof ArrayBuffer);
  t.true(/** @type {any} */ (immutable.buffer).immutable);
});

test('frozenBytes: empty input', t => {
  const immutable = frozenBytes(new Uint8Array(0));
  t.is(immutable.byteLength, 0);
});

test('frozenBytes: honors subarray byteOffset and byteLength', t => {
  const full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const window = full.subarray(2, 6); // [2, 3, 4, 5]
  const immutable = frozenBytes(window);
  t.is(immutable.byteLength, 4);
  t.deepEqual([...thawedBytes(immutable)], [2, 3, 4, 5]);
});

test('thawedBytes: copies bytes into a fresh Uint8Array', t => {
  const source = new Uint8Array([0, 1, 2, 0xff, 0x80, 0x00, 42, 100]);
  const immutable = frozenBytes(source);
  const result = thawedBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, source.length);
  t.deepEqual([...result], [...source]);
});

test('thawedBytes: empty input', t => {
  const immutable = frozenBytes(new Uint8Array(0));
  const result = thawedBytes(immutable);
  t.true(result instanceof Uint8Array);
  t.is(result.length, 0);
});

test('frozenBytes + concatBytes composition: assemble from chunks', t => {
  const parts = [
    new Uint8Array([1, 2]),
    new Uint8Array([3]),
    new Uint8Array([4, 5]),
  ];
  const combined = frozenBytes(concatBytes(parts));
  t.deepEqual([...thawedBytes(combined)], [1, 2, 3, 4, 5]);
});

test('concatImmutables: empty input yields empty immutable Uint8Array', t => {
  const result = concatImmutables([]);
  t.true(result instanceof Uint8Array);
  t.is(result.byteLength, 0);
});

test('concatImmutables: concatenates multiple immutable buffers byte-for-byte', t => {
  const parts = [
    frozenBytes(new Uint8Array([1, 2, 3])),
    frozenBytes(new Uint8Array([])),
    frozenBytes(new Uint8Array([4])),
    frozenBytes(new Uint8Array([5, 6, 7, 8])),
  ];
  const result = concatImmutables(parts);
  t.is(result.byteLength, 8);
  t.deepEqual([...thawedBytes(result)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('concatImmutables: result is hardened', t => {
  const parts = [frozenBytes(new Uint8Array([42]))];
  const result = concatImmutables(parts);
  t.true(Object.isFrozen(result));
});

// The emulated-vs-genuine distinguisher this package depends on:
// `ArrayBuffer.isView`.
//
// An emulated freezable `Uint8Array` produced by `@endo/immutable-arraybuffer`
// is a plain ordinary object, so `ArrayBuffer.isView(wrapper) === false`,
// whereas a genuine `Uint8Array` reports `true`. This is the single committed
// emulated-vs-genuine fidelity loss (see that package's README "The one
// committed fidelity loss: an emulated wrapper is not `ArrayBuffer.isView`"),
// and `compareBytes` gates its copy decision on it: it indexes a genuine view
// in place and copies a non-view (emulated) wrapper into a genuine mutable
// `Uint8Array` first. These tests catch a silent breakage on this (client)
// side: if `compareBytes` ever indexed a non-view wrapper directly it would
// read `undefined` for every position and report all inputs as equal.
//
// `wrapper[i] === undefined` is a real but incidental consequence of the
// wrapper's plain-object shape (the same nature that makes `isView` false),
// not the committed distinguisher; the second test records it as a companion
// observation. The shim-side mirror of the committed contract is pinned in
// `@endo/immutable-arraybuffer`'s `test/shim-typedarray.test.js`.
emulatedOnlyTest(
  'emulated byteArray wrapper is not ArrayBuffer.isView; a genuine Uint8Array is',
  t => {
    const wrapper = frozenBytes(new Uint8Array([1, 2, 3]));
    // The committed distinguisher `compareBytes` leans on.
    t.false(ArrayBuffer.isView(wrapper));
    t.true(ArrayBuffer.isView(new Uint8Array([1, 2, 3])));
  },
);

emulatedOnlyTest(
  'emulated byteArray wrapper: direct integer-indexed read is undefined (incidental)',
  t => {
    const wrapper = frozenBytes(new Uint8Array([1, 2, 3]));
    // Not the byte: the wrapper carries no integer-indexed own properties and
    // the shim installs no read-through getter. The static type says `number`
    // (the narrowed `Uint8Array`), but the emulated wrapper answers `undefined`
    // at runtime; cast through `unknown` so the assertion type-checks.
    t.is(/** @type {unknown} */ (wrapper[0]), undefined);
    t.is(/** @type {unknown} */ (wrapper[2]), undefined);
  },
);

test('compareBytes: orders emulated byteArray wrappers by their real bytes', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const b = frozenBytes(new Uint8Array([1, 2, 4]));
  const aAgain = frozenBytes(new Uint8Array([1, 2, 3]));

  // A negative/positive/zero triple that is only reachable if `compareBytes`
  // reads the real bytes. Were it to index the wrapper directly (reading
  // `undefined` everywhere) every comparison would collapse to 0.
  t.true(compareBytes(a, b) < 0);
  t.true(compareBytes(b, a) > 0);
  t.is(compareBytes(a, aAgain), 0);

  // Prefix: shorter sorts before longer.
  const abcd = frozenBytes(new Uint8Array([1, 2, 3, 4]));
  t.true(compareBytes(a, abcd) < 0);
});

test('compareBytes: emulated wrapper against a genuine mutable Uint8Array', t => {
  const emulated = frozenBytes(new Uint8Array([1, 2, 3]));
  const genuine = new Uint8Array([1, 2, 4]);
  t.true(compareBytes(emulated, genuine) < 0);
  t.true(compareBytes(genuine, emulated) > 0);
});

// The same emulated-vs-genuine hazard for `bytesEqual`. Were it to index a
// non-view wrapper directly it would read `undefined` at every position, so
// two distinct equal-length wrappers would collapse to `undefined !==
// undefined` (false) and compare *equal*, while an emulated-vs-genuine pair
// would compare *unequal*. These tests only pass if `bytesEqual` reads the
// real bytes (thawing the wrapper first).

test('bytesEqual: distinct emulated byteArray wrappers with different bytes are unequal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const b = frozenBytes(new Uint8Array([1, 2, 4]));
  t.false(bytesEqual(a, b));
});

test('bytesEqual: distinct emulated byteArray wrappers with equal bytes are equal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const aAgain = frozenBytes(new Uint8Array([1, 2, 3]));
  t.true(bytesEqual(a, aAgain));
});

test('bytesEqual: emulated wrapper against an equal genuine mutable Uint8Array', t => {
  const emulated = frozenBytes(new Uint8Array([1, 2, 3]));
  const genuine = new Uint8Array([1, 2, 3]);
  t.true(bytesEqual(emulated, genuine));
  t.true(bytesEqual(genuine, emulated));
});

test('bytesEqual: emulated wrapper against an unequal genuine mutable Uint8Array', t => {
  const emulated = frozenBytes(new Uint8Array([1, 2, 3]));
  const genuine = new Uint8Array([1, 2, 4]);
  t.false(bytesEqual(emulated, genuine));
  t.false(bytesEqual(genuine, emulated));
});

test('bytesEqual: emulated wrappers of different lengths are unequal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const abcd = frozenBytes(new Uint8Array([1, 2, 3, 4]));
  t.false(bytesEqual(a, abcd));
});

// The same emulated-vs-genuine hazard for `concatBytes`. A non-view wrapper
// handed to `Uint8Array.prototype.set` as a source would be read through
// `set`'s native fast path, which sees the wrapper's plain-object shape and
// copies zeros — silently dropping the real bytes. `concatBytes` therefore
// relies on the identical `isView` gate as `compareBytes`/`bytesEqual`,
// thawing a non-view wrapper before assembly. These tests only pass if the
// real bytes survive the concat.

test('concatBytes: assembles emulated byteArray wrappers by their real bytes', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const b = frozenBytes(new Uint8Array([4, 5]));
  const result = concatBytes([a, b]);
  t.deepEqual([...result], [1, 2, 3, 4, 5]);
});

test('concatBytes: mixes emulated wrappers with genuine mutable chunks', t => {
  const emulated = frozenBytes(new Uint8Array([1, 2, 3]));
  const genuine = new Uint8Array([4, 5, 6]);
  t.deepEqual([...concatBytes([emulated, genuine])], [1, 2, 3, 4, 5, 6]);
  t.deepEqual([...concatBytes([genuine, emulated])], [4, 5, 6, 1, 2, 3]);
});
