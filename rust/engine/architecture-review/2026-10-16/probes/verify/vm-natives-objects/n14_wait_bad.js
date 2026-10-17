let r;
try { r = Atomics.wait(new Int32Array(4), 0, 0, 0); } catch (e) { r = e.name; }
throw new Error(JSON.stringify(['wait-nonshared', r]));
