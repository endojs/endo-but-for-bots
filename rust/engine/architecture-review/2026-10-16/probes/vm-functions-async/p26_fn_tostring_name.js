const out = [];
out.push((function foo(a) { return a; }).toString());
out.push((() => 1).toString());
out.push(class K {}.toString());
const f = function bar() {};
Object.defineProperty(f, 'name', { value: 'renamed' });
function thrower() { throw new Error('x'); }
Object.defineProperty(thrower, 'name', { value: 'renamedThrower' });
try { thrower(); } catch (e) { out.push(e.stack.split('\n')[1]); }
out.push(String(f));
throw new Error(JSON.stringify(out));
