// ARCHITECTURE.md:349-351: guest-created string/symbol keys raise a catchable RangeError
// before exhausting the 16-bit namespace, retaining 1,024 IDs.
const o = {};
let i = 0, err = null;
try { for (; i < 70000; i++) o['k' + i] = i; } catch (e) { err = e.constructor.name + ': ' + e.message; }
let syms = 0, serr = null;
try { for (; syms < 70000; syms++) { const s = Symbol('s'); o[s] = 1; } } catch (e) { serr = e.constructor.name + ': ' + e.message; }
throw new Error(JSON.stringify({ strings: i, err, syms, serr }));
