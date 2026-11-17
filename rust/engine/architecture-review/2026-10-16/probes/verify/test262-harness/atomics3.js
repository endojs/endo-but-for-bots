var r;
try { Atomics.wait(new Int32Array(new SharedArrayBuffer(16)), 0, 1, 0); r = 'returned'; } catch (e) { r = 'caught ' + e.name; }
throw new Error(r);
