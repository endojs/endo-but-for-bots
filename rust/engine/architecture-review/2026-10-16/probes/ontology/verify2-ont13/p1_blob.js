// Binary blob copied through a float view: how many bytes change?
var out = {};
function t(name, f) { try { out[name] = f(); } catch (e) { out[name] = 'THREW ' + e.name + ': ' + e.message; } }
function blob(n) { // deterministic xorshift32 bytes
  var u = new Uint8Array(n); var s = 0x12345678;
  for (var i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; u[i] = s & 0xff; }
  return u;
}
function diffWords(a, b, w) { var d = 0; for (var i = 0; i < a.length; i += w) { for (var j = 0; j < w; j++) { if (a[i + j] !== b[i + j]) { d++; break; } } } return d; }
var N = 1 << 16;
t('f64_ctor_changed_words_of_8192', function () { var u = blob(N); var c = new Float64Array(new Float64Array(u.buffer)); return diffWords(u, new Uint8Array(c.buffer), 8); });
t('f32_ctor_changed_words_of_16384', function () { var u = blob(N); var c = new Float32Array(new Float32Array(u.buffer)); return diffWords(u, new Uint8Array(c.buffer), 4); });
t('f64_slice_changed', function () { var u = blob(N); var c = new Float64Array(u.buffer).slice(); return diffWords(u, new Uint8Array(c.buffer), 8); });
t('f64_set_changed', function () { var u = blob(N); var c = new Float64Array(N / 8); c.set(new Float64Array(u.buffer)); return diffWords(u, new Uint8Array(c.buffer), 8); });
t('ab_slice_then_view_changed', function () { var u = blob(N); var c = new Float64Array(u.buffer.slice(0)); return diffWords(u, new Uint8Array(c.buffer), 8); });
t('u8_ctor_changed', function () { var u = blob(N); var c = new Uint8Array(u); return diffWords(u, c, 1); });
throw new Error(JSON.stringify(out));
