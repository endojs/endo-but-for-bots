/*---
description: TypedArray intrinsics preserve in-place methods
features: [TypedArray]
---*/

var values = new Uint8Array([4, 1, 3, 2]);

values.copyWithin(1, 2);
assert.sameValue(values.join(','), '4,3,2,2', 'copyWithin');

values.fill(7, 2);
assert.sameValue(values.join(','), '4,3,7,7', 'fill');

values.reverse();
assert.sameValue(values.join(','), '7,7,3,4', 'reverse');

values.sort();
assert.sameValue(values.join(','), '3,4,7,7', 'sort');

values.set([8, 9], 1);
assert.sameValue(values.join(','), '3,8,9,7', 'set');

assert.throws(
  RangeError,
  () => values.set([1, 2, 3], 3),
  'set rejects an out-of-bounds offset after lockdown',
);
