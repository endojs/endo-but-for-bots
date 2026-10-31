// Does a start-compartment function created BEFORE the first `new Compartment()`
// (capture_global_environment returned NULL then) keep the start global when a
// child calls it?  ECMA-262: a function's [[Realm]]/[[Environment]] is fixed at
// creation; SES: start-compartment functions close over the start global.
globalThis.marker = 'START';
function readBefore() { return globalThis.marker; }
function freeBefore() { return marker; }
function defineBefore() { globalThis.definedByBefore = 1; }
const c = new Compartment({ globals: { marker: 'CHILD', readBefore, freeBefore, defineBefore } });
function readAfter() { return globalThis.marker; }
const r = {};
r.readBefore = c.evaluate('readBefore()');
r.freeBefore = c.evaluate('freeBefore()');
c.evaluate('defineBefore()');
r.startHasDefined = typeof globalThis.definedByBefore;
r.childHasDefined = c.evaluate('typeof globalThis.definedByBefore');
const callIn = c.evaluate('(f) => f()');
r.readAfterViaChild = callIn(readAfter);
r.readBeforeViaChild = callIn(readBefore);
throw new Error(JSON.stringify(r));
