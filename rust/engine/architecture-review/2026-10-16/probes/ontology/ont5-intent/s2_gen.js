const EXPECT = 'START';
globalThis.marker = 'START';
lockdown();
// report halts (HeapExhausted) iff the START-registered eval job did NOT see START.
function report(v) { if (v !== EXPECT) { const a = []; for (;;) a.push(new Array(1e6)); } }
const c = new Compartment({ globals: { marker: 'CHILD' } });
const g = c.evaluate("(function*(){ yield marker; yield marker; })")(); g.next(); Promise.resolve("marker").then(eval).then(report);
