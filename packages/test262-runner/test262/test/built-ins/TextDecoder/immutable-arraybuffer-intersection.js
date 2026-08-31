/*---
description: TextDecoder accepts genuine immutable views and thawed emulated views (prefer-endo-primitives-exempt standalone Test262 case)
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/
// prefer-endo-primitives-exempt: Test262 cases must be self-contained scripts.

var decoder = new TextDecoder();
var mutableBytes = new Uint8Array([0x41, 0xc2, 0xa2, 0xe2, 0x82, 0xac]);
var frozen = frozenBytes(mutableBytes);
var thawed = thawedBytes(frozen);

assert.sameValue(frozen.buffer.immutable, true);
assert.sameValue(Object.isFrozen(frozen), true);
assert.notSameValue(thawed.buffer.immutable, true);
assert.sameValue(Object.isFrozen(thawed), false);
assert.sameValue(decoder.decode(mutableBytes), 'A¢€');
assert.sameValue(decoder.decode(thawed), 'A¢€');

if (ArrayBuffer.isView(frozen)) {
  assert.sameValue(decoder.decode(frozen), 'A¢€');
} else {
  var frozenDecodeRejected = false;
  try {
    decoder.decode(frozen);
  } catch (error) {
    frozenDecodeRejected = true;
    assert.sameValue(error.name, 'TypeError');
  }
  assert.sameValue(frozenDecodeRejected, true);
}
