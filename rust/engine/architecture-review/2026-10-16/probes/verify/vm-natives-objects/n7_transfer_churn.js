let b = new ArrayBuffer(4 << 20);
let i = 0;
try { for (; i < 200; i++) b = b.transfer(); } catch (e) { throw new Error('caught at ' + i + ' ' + e.name); }
throw new Error('done ' + i + ' ' + b.byteLength);
