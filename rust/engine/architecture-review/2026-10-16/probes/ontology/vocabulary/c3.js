lockdown();
const out = {};
try { out.r = typeof (function(){}).constructor("return 1"); } catch (e) { out.e = e.name + ": " + e.message; }
const c = new Compartment({ globals: { marker: 1 } });
try { out.inner = c.evaluate("(function(){}).constructor('return typeof marker')()"); } catch (e) { out.innerE = e.name + ": " + e.message; }
throw new Error(JSON.stringify(out));
