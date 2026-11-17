const EXPECT = 'START';
globalThis.marker = 'START';
lockdown();
// report halts (HeapExhausted) iff the START-registered eval job did NOT see START.
function report(v) { if (v !== EXPECT) { const a = []; for (;;) a.push(new Array(1e6)); } }
const c = new Compartment({ globals: { marker: 'CHILD' } });
Promise.resolve(1).then(c.evaluate("(() => { throw 1; })")).catch(()=>{}); Promise.resolve("marker").then(eval).then(report);
