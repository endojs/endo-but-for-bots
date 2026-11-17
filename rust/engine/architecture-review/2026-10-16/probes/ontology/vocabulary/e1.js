// Which "eval" identities count as direct eval inside a compartment?
const out = {};
var x = "outer-global";
const c = new Compartment({ globals: { outerEval: eval, x: "comp-global" } });
out.compOwnEvalIsOuter = c.evaluate("eval") === eval;
out.ownDirect = c.evaluate("(function(){ const x = 'local'; return eval('x'); })()");
out.outerEvalAsDirect = c.evaluate("globalThis.eval = outerEval; (function(){ const x = 'local'; return eval('x'); })()");
// start compartment: the compartment's eval reached under the name eval
const compEval = new Compartment({ globals: { x: "comp2-global" } }).evaluate("eval");
const savedEval = globalThis.eval;
globalThis.eval = compEval;
out.compEvalInOuterDirect = (function(){ var x = 'local'; return eval('x'); })();
globalThis.eval = savedEval;
throw new Error(JSON.stringify(out));
