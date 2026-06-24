/*---
description: >
  encodeUtf8 encodes a string as a frozen byteArray (immutable-backed Uint8Array).
  The encoded bytes are valid UTF-8; thawnBytes produces the same sequence a
  TextEncoder would produce.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/encode-utf8.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var result = encodeUtf8('Hello');

assert(result instanceof Uint8Array, 'result is Uint8Array');
assert.sameValue(result.buffer.immutable, true, 'backing buffer is immutable');
assert(Object.isFrozen(result), 'result is frozen');

// ASCII characters encode as single bytes.
var mutable = thawnBytes(result);
assert.sameValue(mutable.length, 5, '5 bytes for 5 ASCII chars');
assert.sameValue(mutable[0], 72, 'H');
assert.sameValue(mutable[1], 101, 'e');
assert.sameValue(mutable[2], 108, 'l');
assert.sameValue(mutable[3], 108, 'l');
assert.sameValue(mutable[4], 111, 'o');
