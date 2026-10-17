const c = new Compartment();
const r = [];
try { r.push(String(c.evaluate('var v = 1; function f() { return 7; } let cl = 5; 0'))); } catch (e) { r.push('decl:' + e.name); }
for (const src of ['typeof v', 'typeof f', 'typeof cl']) { try { r.push(c.evaluate(src)); } catch (e) { r.push(e.name); } }
try { r.push(String(c.evaluate('f()'))); } catch (e) { r.push(e.name); }
r.push(Object.getOwnPropertyNames(c.globalThis).filter(n => n === 'v' || n === 'f').join('+'));
// a common split pattern: helper defined in one evaluate, used in another
try { c.evaluate('function helper(x) { return x * 2; }'); r.push(String(c.evaluate('helper(21)'))); } catch (e) { r.push('split:' + e.name); }
throw new Error(JSON.stringify(r));
