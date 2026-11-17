// Side question for the realm.rs:311-313 invariant: after lockdown() on a machine
// that already held a guest compartment, are that compartment's own minted
// evaluator copies (and its global object) hardened like SES does?
import "/home/user/endo-but-for-bots/packages/ses/index.js";
const c = new Compartment({});
lockdown();
const r = {};
r.childFunctionFrozen = Object.isFrozen(c.evaluate('Function'));
r.childEvalFrozen = Object.isFrozen(c.evaluate('eval'));
r.childCompartmentFrozen = Object.isFrozen(c.evaluate('Compartment'));
r.childGlobalFrozen = Object.isFrozen(c.globalThis);
r.startFunctionFrozen = Object.isFrozen(Function);
console.log(JSON.stringify(r));
