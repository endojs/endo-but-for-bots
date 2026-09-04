/*---
description: byte readers preserve values for immutable pass-style bytes
includes: [compareArray.js]
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var left = frozenBytes(new Uint8Array([1, 2, 3]));
var right = frozenBytes(new Uint8Array([1, 2, 4]));

assert(compareBytes(left, right) < 0);
assert.compareArray(concatBytes([left, right]), [1, 2, 3, 1, 2, 4]);
