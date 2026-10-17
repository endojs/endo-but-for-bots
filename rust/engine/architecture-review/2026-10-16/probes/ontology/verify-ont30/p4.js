// Same as p3 but distinguishes functions created before vs after the first
// `new Compartment()` (function EXPRESSIONS, so creation order is program order).
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
throw new Error(JSON.stringify(r));
