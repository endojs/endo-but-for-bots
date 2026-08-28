/*---
description: TypedArray intrinsics preserve copying behavior
features: [TypedArray]
---*/

var source = new Uint8Array([1, 2, 3, 4, 5]);

assert.sameValue(source.slice(1, 4).join(','), '2,3,4', 'slice');

var subarray = source.subarray(1, 4);
assert.sameValue(subarray.join(','), '2,3,4', 'subarray values');
subarray[0] = 9;
assert.sameValue(source[1], 9, 'subarray shares storage');

assert.sameValue(
  source.map(value => value + 1).join(','),
  '2,10,4,5,6',
  'map',
);
assert.sameValue(
  source.filter(value => value % 2 === 1).join(','),
  '1,9,3,5',
  'filter',
);
