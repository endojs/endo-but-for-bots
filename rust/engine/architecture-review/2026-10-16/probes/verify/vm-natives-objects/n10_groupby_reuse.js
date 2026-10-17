const N = 1000005;
let closed = false;
const res = { value: 0, done: false };
const it = { i: 0, next() { if (this.i++ < N) { res.value = this.i; return res; } return { value: undefined, done: true }; }, return() { closed = true; return {}; }, [Symbol.iterator]() { return this; } };
let n = 0;
const g = Map.groupBy(it, x => 0);
throw new Error(JSON.stringify(['map-groupBy', g.get(0).length, it.i, closed]));
