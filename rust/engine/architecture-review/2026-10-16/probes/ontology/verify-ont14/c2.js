// Same shared %Function% object; which global does it bind? (no lockdown)
const out = {};
const c = new Compartment({ globals: { marker: 1 } });
const F = c.evaluate("(function(){}).constructor");
out.sameObject = F === Function.prototype.constructor;
out.outerCallGlobalIsOuter = F("return globalThis")() === globalThis;
c.globalThis.F = F;
out.innerCallGlobalIsOuter = c.evaluate("F('return globalThis')()") === globalThis;
// outer function that calls F, invoked from inside the compartment
c.globalThis.viaOuter = () => F("return globalThis")();
out.outerClosureFromInnerIsOuter = c.evaluate("viaOuter()") === globalThis;
throw new Error(JSON.stringify(out));
