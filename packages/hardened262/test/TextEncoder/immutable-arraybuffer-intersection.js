/*---
description: TextEncoder produces mutable bytes and rejects frozen destinations
includes: [compareArray.js]
---*/

var encoder = new TextEncoder();
var encoded = encoder.encode('A¢€');

assert.sameValue(ArrayBuffer.isView(encoded), true);
assert.notSameValue(encoded.buffer.immutable, true);
assert.sameValue(Object.isFrozen(encoded), false);
assert.compareArray(encoded, [0x41, 0xc2, 0xa2, 0xe2, 0x82, 0xac]);

var mutableDestination = new Uint8Array(8);
var mutableResult = encoder.encodeInto('A¢', mutableDestination);
assert.sameValue(mutableResult.read, 2);
assert.sameValue(mutableResult.written, 3);
assert.compareArray(mutableDestination.slice(0, 3), [0x41, 0xc2, 0xa2]);

var immutableBuffer = new ArrayBuffer(8).sliceToImmutable();
var frozenDestination = Object.freeze(new Uint8Array(immutableBuffer));
assert.sameValue(frozenDestination.buffer.immutable, true);
assert.sameValue(Object.isFrozen(frozenDestination), true);

var frozenDestinationRejected = false;
try {
  encoder.encodeInto('A', frozenDestination);
} catch (error) {
  frozenDestinationRejected = true;
  assert.sameValue(error.name, 'TypeError');
}
assert.sameValue(frozenDestinationRejected, true);

var thawedDestination = frozenDestination.slice(0);
var thawedResult = encoder.encodeInto('A', thawedDestination);
assert.sameValue(thawedResult.read, 1);
assert.sameValue(thawedResult.written, 1);
assert.sameValue(thawedDestination[0], 0x41);
assert.notSameValue(thawedDestination.buffer.immutable, true);
