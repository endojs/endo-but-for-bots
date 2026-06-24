/*---
description: >
  concatBytes concatenates multiple frozen byteArray values into one frozen
  byteArray backed by an immutable ArrayBuffer.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/concat-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var parts = [
  frozenBytes(new Uint8Array([1, 2, 3])),
  frozenBytes(new Uint8Array([])),
  frozenBytes(new Uint8Array([4])),
  frozenBytes(new Uint8Array([5, 6, 7, 8]))
];
var result = concatBytes(parts);

assert(result instanceof Uint8Array, 'result is Uint8Array');
assert.sameValue(result.byteLength, 8, 'total byte length');
assert.sameValue(result.buffer.immutable, true, 'backing buffer is immutable');
assert(Object.isFrozen(result), 'result is frozen');

var mutable = thawnBytes(result);
assert.sameValue(mutable[0], 1, 'byte 0');
assert.sameValue(mutable[1], 2, 'byte 1');
assert.sameValue(mutable[2], 3, 'byte 2');
assert.sameValue(mutable[3], 4, 'byte 3');
assert.sameValue(mutable[4], 5, 'byte 4');
assert.sameValue(mutable[5], 6, 'byte 5');
assert.sameValue(mutable[6], 7, 'byte 6');
assert.sameValue(mutable[7], 8, 'byte 7');
