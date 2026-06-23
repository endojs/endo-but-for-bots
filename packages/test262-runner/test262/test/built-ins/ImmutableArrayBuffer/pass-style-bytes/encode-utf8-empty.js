/*---
description: >
  encodeUtf8 of an empty string produces a zero-length frozen byteArray.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/encode-utf8.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var result = encodeUtf8('');

assert(result instanceof Uint8Array, 'result is Uint8Array');
assert.sameValue(result.byteLength, 0, 'byteLength is 0');
assert.sameValue(result.buffer.immutable, true, 'backing buffer is immutable');
assert(Object.isFrozen(result), 'result is frozen');
