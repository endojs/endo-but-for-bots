const EXPECT = 'CHILD';
globalThis.marker = 'START';
lockdown();
// report halts (HeapExhausted) iff the START-registered eval job did NOT see START.
function report(v) { if (v !== EXPECT) { const a = []; for (;;) a.push(new Array(1e6)); } }
const c = new Compartment({ globals: { marker: 'CHILD' } });
Promise.resolve("marker").then(v => c.evaluate("Promise.resolve(1).then(() => marker)")).then(() => 0); Promise.resolve("marker").then(eval).then(report);
