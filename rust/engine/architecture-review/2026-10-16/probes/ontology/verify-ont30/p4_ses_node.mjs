import '/home/user/endo-but-for-bots/packages/ses/index.js';
// SES reference for p4.js (no lockdown: SES compartments work before lockdown too).
globalThis.marker = 'START';
const readBefore = function () { return globalThis.marker; };
const defineBefore = function () { globalThis.definedByBefore = 1; };
const c = new Compartment({ globals: { marker: 'CHILD' } });
const readAfter = function () { return globalThis.marker; };
const defineAfter = function () { globalThis.definedByAfter = 1; };
const callIn = c.evaluate('(f) => f()');
const r = {};
r.readBefore = callIn(readBefore);
r.readAfter = callIn(readAfter);
callIn(defineBefore);
callIn(defineAfter);
r.startHasBefore = typeof globalThis.definedByBefore;
r.childHasBefore = c.evaluate('typeof globalThis.definedByBefore');
r.startHasAfter = typeof globalThis.definedByAfter;
r.childHasAfter = c.evaluate('typeof globalThis.definedByAfter');
console.log(JSON.stringify(r));
