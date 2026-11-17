const EXPECT = 'CHILD';
globalThis.marker = 'START';
lockdown();
// report halts (HeapExhausted) iff the START-registered eval job did NOT see START.
function report(v) { if (v !== EXPECT) { const a = []; for (;;) a.push(new Array(1e6)); } }
const c = new Compartment({ globals: { marker: 'CHILD' } });
const inner = c.evaluate("new Compartment({globals:{marker:\"GRAND\"}})"); const h = inner.evaluate("(async () => { await null; return marker; })"); h(); Promise.resolve("marker").then(eval).then(report);
