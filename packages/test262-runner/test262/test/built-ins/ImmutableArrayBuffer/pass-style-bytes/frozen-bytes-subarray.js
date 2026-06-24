/*---
description: >
  frozenBytes honors the byteOffset and byteLength of a subarray view: only the
  windowed bytes are captured in the immutable result.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/to-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
// subarray does not copy: it returns a view with byteOffset=2, byteLength=4
var window = full.subarray(2, 6);
var result = frozenBytes(window);

assert.sameValue(result.byteLength, 4, 'only the windowed bytes are captured');

// Verify byte values via thawnBytes (which produces a plain mutable copy).
var mutable = thawnBytes(result);
assert.sameValue(mutable[0], 2, 'byte 0 is 2');
assert.sameValue(mutable[1], 3, 'byte 1 is 3');
assert.sameValue(mutable[2], 4, 'byte 2 is 4');
assert.sameValue(mutable[3], 5, 'byte 3 is 5');
