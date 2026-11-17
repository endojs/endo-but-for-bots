// Pre-lockdown and post-lockdown: what does a compartment guest reach via shared prototype constructors?
globalThis.marker = 'START';
const r = {};
const c = new Compartment({ globals: { marker: 'CHILD' } });
const probe = `
  const out = {};
  out.globalMarker = globalThis.marker;
  out.FunctionIsGlobalFunction = (function(){}).constructor === Function;
  try { out.viaProtoCtor = (function(){}).constructor('return globalThis.marker')(); } catch (e) { out.viaProtoCtor = 'threw ' + e.name + ': ' + e.message; }
  try { out.viaGlobalFunction = Function('return globalThis.marker')(); } catch (e) { out.viaGlobalFunction = 'threw ' + e.name; }
  try { out.viaAsyncCtor = typeof Object.getPrototypeOf(async function(){}).constructor; } catch (e) { out.viaAsyncCtor = 'threw ' + e.name; }
  try { out.viaGenCtor = Object.getPrototypeOf(function*(){}).constructor('return globalThis.marker')().next().value; } catch (e) { out.viaGenCtor = 'threw ' + e.name + ': ' + e.message; }
  try { out.indirectEval = (0, eval)('globalThis.marker'); } catch (e) { out.indirectEval = 'threw ' + e.name; }
  out;
`;
r.pre = c.evaluate(probe);
lockdown();
const c2 = new Compartment({ globals: { marker: 'CHILD2' } });
r.postOld = c.evaluate(probe);
r.postNew = c2.evaluate(probe);
throw new Error(JSON.stringify(r));
