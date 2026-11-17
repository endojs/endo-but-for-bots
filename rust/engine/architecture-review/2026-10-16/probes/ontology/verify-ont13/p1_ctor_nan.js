var out = {};
function t(name, f) { try { out[name] = f(); } catch (e) { out[name] = 'THREW ' + e.name + ': ' + e.message; } }
function bytes(ta) { return Array.from(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength)).join(','); }
// Float64 payload NaN (non-canonical mantissa)
t('f64_ctor', function () { var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); return bytes(new Float64Array(f)); });
// Negative quiet NaN (sign bit set)
t('f64_ctor_negnan', function () { var b = new Uint8Array([0,0,0,0,0,0,0xf8,0xff]); var f = new Float64Array(b.buffer); return bytes(new Float64Array(f)); });
// Source is a view with non-zero byteOffset
t('f64_ctor_offset', function () { var b = new Uint8Array([9,9,9,9,9,9,9,9, 1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer, 8, 1); return bytes(new Float64Array(f)); });
// Float32 payload NaN
t('f32_ctor', function () { var b = new Uint8Array([1,0,0xc0,0x7f]); var f = new Float32Array(b.buffer); return bytes(new Float32Array(f)); });
// Controls: same-type set / slice / copyWithin
t('f64_set', function () { var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); var g = new Float64Array(1); g.set(f); return bytes(g); });
t('f64_slice', function () { var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); return bytes(f.slice()); });
t('f32_set', function () { var b = new Uint8Array([1,0,0xc0,0x7f]); var f = new Float32Array(b.buffer); var g = new Float32Array(1); g.set(f); return bytes(g); });
t('f32_slice', function () { var b = new Uint8Array([1,0,0xc0,0x7f]); var f = new Float32Array(b.buffer); return bytes(f.slice()); });
// Subclass constructor path (same element type)
t('f64_subclass_ctor', function () { class S extends Float64Array {} var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); return bytes(new S(f)); });
// Integer kinds unaffected (sanity)
t('i32_ctor', function () { var f = new Int32Array([-1, 0x7fffffff]); return bytes(new Int32Array(f)); });
throw new Error(JSON.stringify(out));
