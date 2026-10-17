let i = 0, b;
try { for (; i < 200; i++) b = new ArrayBuffer(4 << 20); } catch (e) { throw new Error('caught at ' + i + ' ' + e.name); }
throw new Error('done ' + i);
