// Spec: waitAsync with v != w -> {async:false, value:'not-equal'} synchronously.
let r;
try { const x = Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(8)), 0, 1, 0); r = JSON.stringify(x); } catch (e) { r = 'caught ' + e.name; }
throw new Error(r);
