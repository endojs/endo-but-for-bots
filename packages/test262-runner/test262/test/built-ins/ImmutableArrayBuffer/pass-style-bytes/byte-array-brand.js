/*---
description: pass-style recognises frozen bytes on immutable ArrayBuffer
includes: [compareArray.js]
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var source = new Uint8Array([0, 1, 127, 128, 255]);
var bytes = frozenBytes(source);

assert.sameValue(passStyleOf(bytes), 'byteArray');
assert.sameValue(Object.isFrozen(bytes), true);
assert.sameValue(bytes.buffer.immutable, true);
assert.compareArray(thawedBytes(bytes), source);
