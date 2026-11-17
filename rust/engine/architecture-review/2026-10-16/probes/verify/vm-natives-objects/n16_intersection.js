const s = new Set([1, 2, 3]);
const other = { size: 10, has(v) { if (v === 1) s.delete(1); return true; }, keys() { return [][Symbol.iterator](); } };
const r = [...s.intersection(other)].join();
throw new Error(JSON.stringify(r));
