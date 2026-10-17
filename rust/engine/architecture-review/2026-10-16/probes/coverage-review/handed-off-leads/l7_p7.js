// Control for p6: a compartment built AFTER lockdown() on the same unfrozen-start machine.
lockdown();
const c = new Compartment({});
const r = {};
r.childFunctionFrozen = Object.isFrozen(c.evaluate('Function'));
r.childEvalFrozen = Object.isFrozen(c.evaluate('eval'));
r.childCompartmentFrozen = Object.isFrozen(c.evaluate('Compartment'));
throw new Error(JSON.stringify(r));
