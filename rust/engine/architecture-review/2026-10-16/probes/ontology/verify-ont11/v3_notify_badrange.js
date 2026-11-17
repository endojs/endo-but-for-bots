// Spec: ValidateAtomicAccess -> RangeError.
let r;
try { Atomics.notify(new Int32Array(new SharedArrayBuffer(8)), 100, 1); r = 'returned'; } catch (e) { r = 'caught ' + e.name; }
throw new Error(r);
