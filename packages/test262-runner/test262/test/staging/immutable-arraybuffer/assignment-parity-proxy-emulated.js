/*---
description: >
  Integer-indexed / property assignment surface of the ALTERNATIVE Proxy-based
  emulated freezable TypedArray (makeFreezableProxyTypedArray, from the prelude),
  on the same platform as the genuine baseline. The Proxy closes the plain
  wrapper's read gap (integer-indexed reads forward to the hidden genuine view)
  and makes integer-indexed assignment THROW rather than create an own property,
  while remaining freezable.
features: [immutable-arraybuffer-parity, TypedArray, Proxy]
---*/

var ab = new ArrayBuffer(4);
new Uint8Array(ab).set([10, 20, 30, 40]);
var iab = ab.sliceToImmutable();

var view = makeFreezableProxyTypedArray(Uint8Array, iab);

// Integer-indexed READ matches a genuine TypedArray (unlike the plain wrapper).
assert.sameValue(view[0], 10, 'proxy indexed read forwards to the byte');
assert.sameValue(view.at(0), 10, 'proxy .at(0) reads the byte');
assert.sameValue(view.byteLength, 4, 'proxy byteLength delegates');

// Integer-indexed WRITE throws (the gain): neither write-through nor an own
// property. The underlying immutable buffer is unchanged.
assert.throws(
  TypeError,
  function () {
    view[0] = 42;
  },
  'proxy indexed write throws',
);
assert.sameValue(
  Object.prototype.hasOwnProperty.call(view, '0'),
  false,
  'proxy indexed write created no own property',
);
assert.sameValue(view.at(0), 10, 'underlying immutable buffer is unchanged');

// The Proxy variant is freezable (the "repaired" proxy over a plain target).
Object.freeze(view);
assert.sameValue(Object.isFrozen(view), true, 'proxy view freezes');

// Assignment still throws after freezing.
assert.throws(
  TypeError,
  function () {
    view[0] = 42;
  },
  'proxy indexed write still throws after freeze',
);
assert.sameValue(view.at(0), 10, 'buffer still unchanged after freeze');
