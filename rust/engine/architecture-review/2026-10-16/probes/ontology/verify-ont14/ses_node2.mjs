import '/home/user/endo-but-for-bots/packages/ses/index.js';
globalThis.tag = 'start';
const realEval = globalThis.eval;
const realFunction = globalThis.Function;
lockdown();
const out = {};
out.evalType = typeof realEval;
const c = new Compartment({ __options__: true, globals: { tag: 'c', startEval: realEval, startFunction: realFunction } });
out.inC = c.evaluate("typeof startEval");
try { out.startEvalCalledFromC = c.evaluate("(0, startEval)('tag')"); } catch (e) { out.startEvalCalledFromC = 'E ' + e.message; }
try { out.startFunctionCalledFromC = c.evaluate("startFunction('return tag')()"); } catch (e) { out.startFunctionCalledFromC = 'E ' + e.message; }
try { out.startEvalWritesFromC = c.evaluate("(0, startEval)('var leaked = 1'); typeof globalThis.leaked"); } catch (e) { out.startEvalWritesFromC = 'E ' + e.message; }
out.leakedOnStart = typeof globalThis.leaked;
out.cEvalCalledFromStart = (0, c.evaluate('eval'))('tag');
console.log(JSON.stringify(out));
