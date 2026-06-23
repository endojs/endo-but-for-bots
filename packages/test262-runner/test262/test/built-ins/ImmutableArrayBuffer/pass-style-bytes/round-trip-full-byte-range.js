/*---
description: >
  toBytes + fromBytes round-trip preserves all 256 possible byte values.
  Validates XS+SES / Node.js+SES parity for the toBytes/fromBytes pair.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var allBytes = new Uint8Array(256);
for (var i = 0; i < 256; i++) {
  allBytes[i] = i;
}

var result = fromBytes(toBytes(allBytes));

assert(result instanceof Uint8Array, 'result is Uint8Array');
assert.sameValue(result.length, 256, 'all 256 bytes present');

for (var j = 0; j < 256; j++) {
  assert.sameValue(result[j], j, 'byte ' + j + ' preserved');
}
