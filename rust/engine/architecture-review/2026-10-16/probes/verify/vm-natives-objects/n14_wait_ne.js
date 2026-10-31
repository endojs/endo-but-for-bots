let r;
try { r = Atomics.wait(new Int32Array(new SharedArrayBuffer(16)), 0, 5, 0); } catch (e) { r = e.name; }
throw new Error(JSON.stringify(['wait-not-equal', r]));
