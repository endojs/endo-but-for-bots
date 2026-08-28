/*---
description: ArrayBuffer intrinsics preserve slice behavior
features: [ArrayBuffer, TypedArray]
---*/

var buffer = new ArrayBuffer(8);
var bytes = new Uint8Array(buffer);
bytes.set([10, 20, 30, 40, 50, 60, 70, 80]);

assert.sameValue(buffer.byteLength, 8, 'byteLength reports the allocation');

var middle = buffer.slice(2, 6);
assert.sameValue(middle.byteLength, 4, 'slice reports the selected length');
assert.sameValue(
  Array.from(new Uint8Array(middle)).join(','),
  '30,40,50,60',
  'slice copies the selected bytes',
);

bytes[2] = 99;
assert.sameValue(
  new Uint8Array(middle)[0],
  30,
  'the sliced buffer has independent storage',
);
