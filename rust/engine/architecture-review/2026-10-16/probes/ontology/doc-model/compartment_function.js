// ARCHITECTURE.md:113-115: "Shared dynamic constructors reached through prototype links use that
// default global; compartment eval and Function objects are bound to their own globals."
globalThis.secret = 'start-compartment-secret';
const out = {};
out.hasCompartment = typeof Compartment;
out.hasLockdown = typeof lockdown;
try {
  const c = new Compartment({ globals: {} });
  out.ownFunction = c.evaluate('typeof Function === "function" ? Function("return typeof secret")() : "none"');
  out.protoFunction = c.evaluate('(function(){}).constructor("return typeof secret")()');
  out.protoFunctionSame = c.evaluate('(function(){}).constructor === Function');
  out.globalSame = c.globalThis === globalThis;
  out.arrSame = c.evaluate('Array') === Array;
} catch (e) { out.err = String(e); }
throw new Error(JSON.stringify(out));
