/*---
description: >
  toBytes handles empty input: returns a zero-length frozen Uint8Array backed
  by an immutable ArrayBuffer.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/to-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var result = toBytes(new Uint8Array(0));

assert(result instanceof Uint8Array, 'result is a Uint8Array');
assert.sameValue(result.byteLength, 0, 'byteLength is 0');
assert.sameValue(result.buffer.immutable, true, 'backing buffer is immutable');
assert(Object.isFrozen(result), 'result is frozen');
