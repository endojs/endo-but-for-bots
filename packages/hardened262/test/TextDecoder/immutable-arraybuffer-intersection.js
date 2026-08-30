/*---
description: TextDecoder accepts genuine immutable views and thawed emulated views
---*/

var decoder = new TextDecoder();
var mutableBytes = new Uint8Array([0x41, 0xc2, 0xa2, 0xe2, 0x82, 0xac]);
var immutableBuffer = mutableBytes.buffer.sliceToImmutable();
var frozenBytes = Object.freeze(new Uint8Array(immutableBuffer));
var thawedBytes = frozenBytes.slice(0);

assert.sameValue(frozenBytes.buffer.immutable, true);
assert.sameValue(Object.isFrozen(frozenBytes), true);
assert.notSameValue(thawedBytes.buffer.immutable, true);
assert.sameValue(Object.isFrozen(thawedBytes), false);
assert.sameValue(decoder.decode(mutableBytes), 'A¢€');
assert.sameValue(decoder.decode(thawedBytes), 'A¢€');

if (ArrayBuffer.isView(frozenBytes)) {
  assert.sameValue(decoder.decode(frozenBytes), 'A¢€');
} else {
  var frozenDecodeRejected = false;
  try {
    decoder.decode(frozenBytes);
  } catch (error) {
    frozenDecodeRejected = true;
    assert.sameValue(error.name, 'TypeError');
  }
  assert.sameValue(frozenDecodeRejected, true);
}
