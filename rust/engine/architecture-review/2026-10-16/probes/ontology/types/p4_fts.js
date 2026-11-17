var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('fctor', function(){ return new Function("return 'x'").toString(); });
t('decl', function(){ return eval("(function g(){ return 'y'; })").toString(); });
t('decl_plain', function(){ function h(a){ return a + 1; } return h.toString(); });
t('arrow', function(){ return ((a) => a).toString(); });
t('nonascii', function(){ return eval("(function g(){ return 'é中'; })").toString(); });
t('lone', function(){ var s = eval("(function g(){ return '\uD800'; })").toString(); return Array.from(s).map(function(c){return c.charCodeAt(0).toString(16)}).join(' '); });
t('ta_slice', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); var g = f.slice(); return Array.from(new Uint8Array(g.buffer)).join(','); });
t('ta_copyWithin', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f,0,0,0,0,0,0,0,0]); var f = new Float64Array(b.buffer); f.copyWithin(1, 0, 1); return Array.from(b.subarray(8)).join(','); });
t('ta_from', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); var g = Float64Array.from(f); return Array.from(new Uint8Array(g.buffer)).join(','); });
t('ta_ctor_f32', function(){ var b = new Uint8Array([1,0,0xc0,0x7f]); var f = new Float32Array(b.buffer); var g = new Float32Array(f); return Array.from(new Uint8Array(g.buffer)).join(','); });
t('ta_slice_f32', function(){ var b = new Uint8Array([1,0,0xc0,0x7f]); var f = new Float32Array(b.buffer); var g = f.slice(); return Array.from(new Uint8Array(g.buffer)).join(','); });
t('ta_toReversed', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); var g = f.toReversed(); return Array.from(new Uint8Array(g.buffer)).join(','); });
t('ab_slice', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var c = new Uint8Array(b.buffer.slice(0)); return Array.from(c).join(','); });
t('structured', function(){ var b = new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]); var f = new Float64Array(b.buffer); var g = new Float64Array(f.buffer.slice(0)); return Array.from(new Uint8Array(g.buffer)).join(','); });
throw new Error(JSON.stringify(out));
