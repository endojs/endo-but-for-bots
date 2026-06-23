/*---
description: >
  The immutable-arraybuffer shim uses a detect-then-skip install policy:
  if sliceToImmutable is already present (native engine support), the shim
  does not overwrite it.
  In both cases the byteArray passable shape is a frozen Uint8Array whose
  backing buffer reports immutable === true.
  This test validates that the observable behavior of toBytes and fromBytes
  is identical regardless of which path (shimmed or native) produced the
  immutable ArrayBuffer.
  Validates XS+SES / Node.js+SES parity for both paths through
  @endo/immutable-arraybuffer.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

// Regardless of whether sliceToImmutable comes from the shim or from a
// native stage-3 implementation, the method must be present on
// ArrayBuffer.prototype after the prelude runs.
assert(
  typeof ArrayBuffer.prototype.sliceToImmutable === 'function',
  'sliceToImmutable is a function on ArrayBuffer.prototype'
);

// toBytes must produce an immutable-backed Uint8Array via whichever path is active.
var bytes = toBytes(new Uint8Array([10, 20, 30]));
assert.sameValue(bytes.buffer.immutable, true, 'buffer is immutable');
assert(Object.isFrozen(bytes), 'Uint8Array wrapper is frozen');

// fromBytes must correctly extract bytes from the immutable buffer.
var copy = fromBytes(bytes);
assert.sameValue(copy[0], 10, 'byte 0');
assert.sameValue(copy[1], 20, 'byte 1');
assert.sameValue(copy[2], 30, 'byte 2');
