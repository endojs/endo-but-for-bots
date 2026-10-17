const EXPECT = 'START';
globalThis.marker = 'START';
lockdown();
// report halts (HeapExhausted) iff the START-registered eval job did NOT see START.
function report(v) { if (v !== EXPECT) { const a = []; for (;;) a.push(new Array(1e6)); } }
const c = new Compartment({ globals: { marker: 'CHILD' } });
const t = c.evaluate("({ then(r) { r(marker); } })"); Promise.resolve(t); Promise.resolve("marker").then(eval).then(report);
