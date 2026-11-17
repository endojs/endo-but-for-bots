// Sloppy `this` (OrdinaryCallBindThis uses the callee's realm global) and
// global var resolution for functions created by the various evaluators.
const out = {};
globalThis.tag = "start";
const c = new Compartment({ globals: { tag: "c" } });
const cg = c.globalThis;
const f1 = c.evaluate("Function('return this')");
out.compFunctionThis = f1() === cg ? "c" : f1() === globalThis ? "start" : "other";
const f2 = c.evaluate("(function(){}).constructor('return this')");
out.protoCtorThis = f2() === cg ? "c" : f2() === globalThis ? "start" : "other";
const f3 = c.evaluate("(function(){}).constructor('return tag')");
out.protoCtorTag = f3();
const f4 = Function("return this");
c.globalThis.f4 = f4;
out.startFnCalledFromC = c.evaluate("f4()") === globalThis ? "start" : "other";
throw new Error(JSON.stringify(out));
