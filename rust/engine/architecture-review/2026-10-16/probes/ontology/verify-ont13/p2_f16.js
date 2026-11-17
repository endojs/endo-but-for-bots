function bytes(ta) { return Array.from(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength)).join(','); }
var b = new Uint8Array([1, 0x7e]); // f16 NaN 0x7e01 (payload)
var f = new Float16Array(b.buffer);
var g = new Float16Array(1); g.set(f);
throw new Error(JSON.stringify({ ctor: bytes(new Float16Array(f)), slice: bytes(f.slice()), set: bytes(g) }));
