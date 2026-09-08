// @ts-check
var b = new ArrayBuffer(8);
var d = new DataView(b);
function bits(n) {
  d.setFloat64(0, n, false);
  return d.getUint32(0, false) + ':' + d.getUint32(4, false);
}
var result = '';
var values = [NaN, 0 / 0, Math.sqrt(-1), -NaN, Infinity - Infinity];
for (var i = 0; i < values.length; i++) result += bits(values[i]) + ',';
// Inject a negative signaling NaN using integer writes. Reading it as a
// Number must not rewrite the backing bytes; writing the Number must.
d.setUint32(0, 0xfff00000, false);
d.setUint32(4, 1, false);
var n = d.getFloat64(0, false);
result += d.getUint32(0, false) + ':' + d.getUint32(4, false) + ',';
result += bits(n) + ',';
n++;
result += bits(n) + ',';
n--;
result += bits(n) + ',';
var f = new Float64Array([n]);
var bytes = new DataView(f.buffer);
result += bytes.getUint32(4, true) + ':' + bytes.getUint32(0, true) + ',';
var g = new Float32Array([n]);
result += new DataView(g.buffer).getUint32(0, true) + ',';
d.setFloat32(0, n, false);
result += d.getUint32(0, false) + ',';
result += bits(-0) + ',' + bits(Infinity) + ',' + bits(-Infinity);
result;
