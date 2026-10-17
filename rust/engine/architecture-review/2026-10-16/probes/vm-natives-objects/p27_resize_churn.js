const b = new ArrayBuffer(4 << 20, { maxByteLength: 4 << 20 });
let i = 0;
try { for (; i < 200; i++) b.resize((4 << 20) - (i & 1) * 8); } catch (e) { throw new Error('caught at ' + i + ' ' + e.name); }
throw new Error('done ' + i);
