/*---
description: >
  thawnBytes returns a distinct copy: the result shares no buffer with the
  immutable input.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/from-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var original = new Uint8Array([10, 20, 30]);
var immutable = frozenBytes(original);
var mutable = thawnBytes(immutable);

// Not the same object.
assert.notSameValue(mutable, original, 'mutable is a different object');
// Not backed by the same ArrayBuffer.
assert.notSameValue(mutable.buffer, immutable.buffer, 'different backing buffer');
// But the byte values agree.
assert.sameValue(mutable[0], 10, 'byte 0');
assert.sameValue(mutable[1], 20, 'byte 1');
assert.sameValue(mutable[2], 30, 'byte 2');
