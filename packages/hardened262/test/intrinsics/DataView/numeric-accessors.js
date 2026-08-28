/*---
description: DataView intrinsics preserve numeric access and byte order
features: [DataView]
---*/

var view = new DataView(new ArrayBuffer(28));

view.setInt8(0, -12);
view.setUint8(1, 250);
view.setInt16(2, -1234, true);
view.setUint16(4, 54321, false);
view.setInt32(6, -12345678, true);
view.setUint32(10, 3456789012, false);
view.setFloat32(14, 1.5, true);
view.setFloat64(20, -Math.PI, false);

assert.sameValue(view.getUint8(4), 0xd4, 'big-endian high byte');
assert.sameValue(view.getUint8(5), 0x31, 'big-endian low byte');
assert.sameValue(view.getUint8(6), 0xb2, 'little-endian low byte');
assert.sameValue(view.getUint8(9), 0xff, 'little-endian high byte');

assert.sameValue(view.getInt8(0), -12, 'Int8');
assert.sameValue(view.getUint8(1), 250, 'Uint8');
assert.sameValue(view.getInt16(2, true), -1234, 'Int16 little-endian');
assert.sameValue(view.getUint16(4, false), 54321, 'Uint16 big-endian');
assert.sameValue(view.getInt32(6, true), -12345678, 'Int32 little-endian');
assert.sameValue(
  view.getUint32(10, false),
  3456789012,
  'Uint32 big-endian',
);
assert.sameValue(view.getFloat32(14, true), 1.5, 'Float32 little-endian');
assert.sameValue(view.getFloat64(20, false), -Math.PI, 'Float64 big-endian');
assert.throws(
  RangeError,
  () => view.getInt32(26, true),
  'an out-of-bounds accessor still throws after lockdown',
);
