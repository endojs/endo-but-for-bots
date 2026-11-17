const c = new Compartment();
c.evaluate('var v = 1; function f() { return 7; } let cl = 5;');
const r = [];
for (const src of ['typeof v', 'typeof f', 'typeof cl']) { try { r.push(c.evaluate(src)); } catch (e) { r.push(e.name); } }
try { r.push(c.evaluate('f()')); } catch (e) { r.push(e.name); }
r.push(Object.getOwnPropertyNames(c.globalThis).filter(n => n === 'v' || n === 'f').join(','));
throw new Error(JSON.stringify(r));
