// Is a compartment's own eval / Function bound to that compartment's global,
// regardless of who calls it?  (ARCHITECTURE.md: "compartment eval and Function
// objects are bound to their own globals")
const out = {};
globalThis.tag = "start";
const c = new Compartment({ globals: { tag: "c", outerEval: eval } });
const cEval = c.evaluate("eval");
const cFunction = c.evaluate("Function");
out.cEvalFromInside = c.evaluate("(0, eval)('tag')");
out.cEvalFromStart = (0, cEval)("tag");
out.cFunctionFromInside = c.evaluate("Function('return tag')()");
out.cFunctionFromStart = cFunction("return tag")();
out.startEvalFromInside = c.evaluate("(0, startEval)('tag')".replace("startEval", "outerEval"), ) ;
throw new Error(JSON.stringify(out));
