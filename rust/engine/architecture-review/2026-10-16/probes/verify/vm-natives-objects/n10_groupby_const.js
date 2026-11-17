const N = 1000005;
const a = []; for (let i = 0; i < N; i++) a.push(i);
let r;
try { const g = Object.groupBy(a.values(), x => 'k'); r = g.k.length; } catch (e) { r = e.name + ': ' + e.message; }
let closed = false;
const it = { i: 0, next() { return this.i++ < N ? { value: this.i, done: false } : { value: undefined, done: true }; }, return() { closed = true; return {}; }, [Symbol.iterator]() { return this; } };
let r2;
try { r2 = Map.groupBy(it, x => 0).get(0).length; } catch (e) { r2 = e.name; }
throw new Error(JSON.stringify(['groupby-const', r, r2, closed]));
