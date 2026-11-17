// Spec: ValidateIntegerTypedArray throws TypeError before anything else.
let r;
try { Atomics.wait({}, 0, 0, 0); r = 'returned'; } catch (e) { r = 'caught ' + e.name; }
throw new Error(r);
