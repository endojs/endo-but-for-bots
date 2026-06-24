/*---
description: >
  thawnBytes copies a frozen Uint8Array backed by an immutable ArrayBuffer into
  a fresh mutable Uint8Array.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/from-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var source = new Uint8Array([0, 1, 2, 255, 128, 0, 42, 100]);
var immutable = frozenBytes(source);
var result = thawnBytes(immutable);

assert(result instanceof Uint8Array, 'result is a Uint8Array');
assert.sameValue(result.length, source.length, 'length matches');
assert.sameValue(result[0], 0, 'byte 0');
assert.sameValue(result[1], 1, 'byte 1');
assert.sameValue(result[2], 2, 'byte 2');
assert.sameValue(result[3], 255, 'byte 3');
assert.sameValue(result[4], 128, 'byte 4');
assert.sameValue(result[5], 0, 'byte 5');
assert.sameValue(result[6], 42, 'byte 6');
assert.sameValue(result[7], 100, 'byte 7');
