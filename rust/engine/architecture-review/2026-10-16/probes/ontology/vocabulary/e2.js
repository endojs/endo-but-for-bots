// Outer realm's eval invoked as a direct eval from inside a compartment:
// which global does the evaluated code see, and which way do var declarations go?
const out = {};
var x = "outer-global";
const c = new Compartment({ globals: { outerEval: eval, x: "comp-global" } });
out.globalSeen = c.evaluate("globalThis.eval = outerEval; (function(){ return eval('x'); })()");
out.globalThisIsComp = c.evaluate("(function(){ return eval('globalThis') === globalThis; })()");
out.indirectOuter = c.evaluate("(0, outerEval)('x')");
// For contrast: start compartment calling compartment eval as indirect
const compEval = c.evaluate("eval");
out.indirectComp = (0, compEval)("x");
throw new Error(JSON.stringify(out));
