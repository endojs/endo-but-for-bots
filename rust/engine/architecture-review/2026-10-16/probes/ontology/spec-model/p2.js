// The start compartment hands its own `eval` and `Function` to a child.
// ECMA-262 19.2.1.1 PerformEval / 20.2.1.1.1 CreateDynamicFunction: an indirect eval
// and a dynamic function are created in the eval/Function object's realm's global
// environment. The start compartment's evaluators belong to the start global.
globalThis.marker = 'START';
lockdown();
const r = {};
r.startFnIsProtoCtor = Function === Function.prototype.constructor;
const c = new Compartment({ globals: { marker: 'CHILD', startEval: eval, startFunction: Function } });
r.childEvalOfStartEval = c.evaluate(`startEval('globalThis.marker')`);
r.childStartFunction = c.evaluate(`startFunction('return globalThis.marker')()`);
r.childDefinesViaStartEval = c.evaluate(`startEval('var definedByChild = 1'); typeof globalThis.definedByChild`);
r.startSeesIt = typeof globalThis.definedByChild;
// and the reverse: a child-bound eval handed back to the start compartment
const childEval = c.evaluate('eval');
r.startCallsChildEval = childEval('globalThis.marker');
throw new Error(JSON.stringify(r));
