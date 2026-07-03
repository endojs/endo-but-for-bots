/*---
description: >
  Integer-indexed / property assignment surface of a GENUINE (non-emulated)
  TypedArray, pinned down so the emulated variants can be compared against it on
  the same platform (Node and XS). A genuine TypedArray over a mutable
  ArrayBuffer writes through on integer-indexed assignment and cannot be frozen.
features: [immutable-arraybuffer-parity, TypedArray]
---*/

var genuine = new Uint8Array([10, 20, 30, 40]);

// Integer-indexed read returns the byte.
assert.sameValue(genuine[0], 10, 'genuine indexed read');

// Integer-indexed assignment writes through to the buffer.
genuine[0] = 42;
assert.sameValue(genuine[0], 42, 'genuine indexed write is observable');
assert.sameValue(
  Uint8Array.prototype.at.call(genuine, 0),
  42,
  'genuine indexed write reached the backing buffer',
);

// Out-of-bounds integer-indexed assignment is silently ignored (no throw, no
// own property) — the Integer-Indexed Exotic [[Set]] swallow.
genuine[99] = 7;
assert.sameValue(genuine[99], undefined, 'genuine OOB write is swallowed');
assert.sameValue(
  Object.prototype.hasOwnProperty.call(genuine, '99'),
  false,
  'genuine OOB write creates no own property',
);

// A genuine TypedArray with elements cannot be frozen: SetIntegrityLevel asks
// the integer-indexed exotic to make index "0" non-configurable, which it
// refuses.
assert.throws(
  TypeError,
  function () {
    Object.freeze(genuine);
  },
  'genuine TypedArray with elements is not freezable',
);
