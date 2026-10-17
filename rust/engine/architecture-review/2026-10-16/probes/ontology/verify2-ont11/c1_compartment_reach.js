// Is Atomics reachable from a guest Compartment after native lockdown?
lockdown();
const c = new Compartment();
const r = {};
r.typeofAtomicsInCompartment = c.evaluate('typeof Atomics');
r.typeofSABInCompartment = c.evaluate('typeof SharedArrayBuffer');
r.frozen = c.evaluate('Object.isFrozen(Atomics)');
throw new Error(JSON.stringify(r));
