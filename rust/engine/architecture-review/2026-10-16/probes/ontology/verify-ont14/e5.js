// After lockdown(): start compartment's eval/Function handed to a child compartment.
lockdown();
const out = {};
globalThis.tag = "start";
const c = new Compartment({ globals: { tag: "c", startEval: eval, startFunction: Function } });
try { out.startFunctionLocal = Function("return tag")(); } catch (e) { out.startFunctionLocal = "E " + e.message; }
try { out.startEvalCalledFromC = c.evaluate("(0, startEval)('tag')"); } catch (e) { out.startEvalCalledFromC = "E " + e.message; }
try { out.startFunctionCalledFromC = c.evaluate("startFunction('return tag')()"); } catch (e) { out.startFunctionCalledFromC = "E " + e.message; }
try { out.startEvalWritesFromC = c.evaluate("(0, startEval)('var leaked = 1'); typeof globalThis.leaked"); } catch (e) { out.startEvalWritesFromC = "E " + e.message; }
out.leakedOnStart = typeof globalThis.leaked;
throw new Error(JSON.stringify(out));
