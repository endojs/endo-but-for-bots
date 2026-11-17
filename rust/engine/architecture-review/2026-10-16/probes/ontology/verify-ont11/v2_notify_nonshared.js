// Spec 25.4.15 step 6: non-shared buffer -> return +0 (no blocking possible).
let r;
try { r = Atomics.notify(new Int32Array(4), 0, 1); } catch (e) { r = 'caught ' + e.name; }
throw new Error(String(r));
