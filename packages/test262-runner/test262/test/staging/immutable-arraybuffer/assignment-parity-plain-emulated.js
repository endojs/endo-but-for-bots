/*---
description: >
  Integer-indexed / property assignment surface of the SHIPPED plain-object
  emulated freezable TypedArray (installed by the @endo/immutable-arraybuffer
  shim in the prelude), on the same platform as the genuine baseline. Two
  divergences from a genuine TypedArray are pinned down: (a) integer-indexed
  READS return undefined (a plain object has no integer-indexed slot), and (b)
  integer-indexed WRITES create a wrapper-local own property instead of writing
  through; the underlying immutable buffer is never touched.
features: [immutable-arraybuffer-parity, TypedArray]
---*/

var ab = new ArrayBuffer(4);
new Uint8Array(ab).set([10, 20, 30, 40]);
var iab = ab.sliceToImmutable();
assert.sameValue(iab.immutable, true, 'buffer is emulated-immutable');

var view = new Uint8Array(iab);
assert.sameValue(
  Object.getPrototypeOf(view),
  Uint8Array.prototype,
  'plain wrapper inherits directly from Uint8Array.prototype',
);

// DIVERGENCE (a): integer-indexed READ is undefined on the plain wrapper, even
// though `.at(0)` reads the byte. A genuine TypedArray returns the byte for both.
assert.sameValue(view[0], undefined, 'plain wrapper indexed read is undefined');
assert.sameValue(view.at(0), 10, 'plain wrapper .at(0) reads the byte');

// DIVERGENCE (b): integer-indexed WRITE creates a wrapper-local own property
// that shadows the read; the underlying immutable buffer is unchanged.
view[0] = 42;
assert.sameValue(view[0], 42, 'plain wrapper indexed write creates own property');
assert.sameValue(
  Object.prototype.hasOwnProperty.call(view, '0'),
  true,
  'plain wrapper indexed write created an own property',
);
assert.sameValue(view.at(0), 10, 'underlying immutable buffer is unchanged');

// The plain wrapper IS freezable (unlike a genuine TypedArray).
Object.freeze(view);
assert.sameValue(Object.isFrozen(view), true, 'plain wrapper freezes');
