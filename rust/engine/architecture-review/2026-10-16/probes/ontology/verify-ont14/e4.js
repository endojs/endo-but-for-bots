// The start compartment's own `eval` / `Function` bindings: bound to the start
// global, or to whichever compartment calls them?
const out = {};
globalThis.tag = "start";
const c = new Compartment({ globals: { tag: "c", startEval: eval, startFunction: Function } });
out.startEvalIsProtoCtorFamily = Function === (function(){}).constructor;
out.startEvalCalledFromC = c.evaluate("(0, startEval)('tag')");
out.startFunctionCalledFromC = c.evaluate("startFunction('return tag')()");
out.cEvalCalledFromStart = (0, c.evaluate("eval"))("tag");
// spec reference point: an intrinsic's realm is fixed ([[Realm]]), so in a
// one-realm-per-global model startEval/startFunction would always see "start".
throw new Error(JSON.stringify(out));
