// Realm/global model inside a Compartment (no lockdown).
const out = {};
const c = new Compartment({ globals: { marker: 1 } });
const g = c.globalThis;
out.globalsDistinct = g !== globalThis;
out.sharedIntrinsicArray = c.evaluate("Array") === Array;
out.sharedFunctionCtor = c.evaluate("Function") === Function;
out.protoCtorIsCompFunction = c.evaluate("(function(){}).constructor === Function");
out.protoCtorGlobal = c.evaluate("(function(){}).constructor('return globalThis')() === globalThis");
out.protoCtorGlobalIsOuter = c.evaluate("(function(){}).constructor('return globalThis')()") === globalThis;
out.compFunctionGlobal = c.evaluate("Function('return globalThis')() === globalThis");
out.compEvalIndirect = c.evaluate("(0, eval)('globalThis') === globalThis");
out.markerViaProtoCtor = c.evaluate("typeof (function(){}).constructor('return marker')");
try { out.markerViaProtoCtorValue = c.evaluate("(function(){}).constructor('return typeof marker')()"); } catch (e) { out.err = String(e); }
throw new Error(JSON.stringify(out));
