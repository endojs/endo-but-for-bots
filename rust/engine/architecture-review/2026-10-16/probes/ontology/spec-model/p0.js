const r = {};
r.Compartment = typeof Compartment;
r.lockdown = typeof lockdown;
r.harden = typeof harden;
r.globalNames = Object.getOwnPropertyNames(globalThis).sort();
throw new Error(JSON.stringify(r));
