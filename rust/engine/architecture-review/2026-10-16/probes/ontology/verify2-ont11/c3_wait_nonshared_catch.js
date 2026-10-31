// Feature-detecting sync sleep: the common "try Atomics.wait, fall back" idiom.
// Spec (any [[CanBlock]]): Atomics.wait on a non-shared Int32Array throws TypeError.
let r;
try { Atomics.wait(new Int32Array(4), 0, 0, 1); r = 'returned'; }
catch (e) { r = 'caught ' + e.name; }
throw new Error(r);
