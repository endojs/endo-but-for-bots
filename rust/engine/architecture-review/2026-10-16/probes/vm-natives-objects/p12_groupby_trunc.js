let closed = false;
const r = { value: 0, done: false };
const it = { i: 0, [Symbol.iterator]() { return this; }, next() { if (this.i < 1000005) { r.value = this.i++; } else { r.done = true; } return r; }, return() { closed = true; return {}; } };
const g = Object.groupBy(it, () => 'a');
throw new Error(JSON.stringify([g.a.length, it.i, closed]));
