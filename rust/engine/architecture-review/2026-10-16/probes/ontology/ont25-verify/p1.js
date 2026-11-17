const c = new Compartment();
const inner = c.evaluate('new Compartment()');
const r = [c.evaluate('1+1'), inner.evaluate('2+2'), c.evaluate('eval("3+3")'), inner.evaluate('Function("return 4")()')];
throw new Error(JSON.stringify(r));
