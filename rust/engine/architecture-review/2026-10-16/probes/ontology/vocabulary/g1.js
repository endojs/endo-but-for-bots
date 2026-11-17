const out = [];
out.push(typeof Compartment, typeof lockdown, typeof harden, typeof globalThis.print);
throw new Error(JSON.stringify(out));
