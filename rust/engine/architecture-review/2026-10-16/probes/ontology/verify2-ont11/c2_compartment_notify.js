// A guest in a hardened Compartment calls Atomics.notify on a NON-shared view
// inside try/catch.  Spec: returns 0 (no waiters, non-shared memory).
lockdown();
const c = new Compartment();
const out = c.evaluate(`
  let r;
  try { r = 'returned ' + Atomics.notify(new Int32Array(4), 0, 1); }
  catch (e) { r = 'caught ' + e.name; }
  r;
`);
throw new Error(out);
