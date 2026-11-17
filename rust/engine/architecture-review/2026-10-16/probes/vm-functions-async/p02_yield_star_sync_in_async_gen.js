const log = [];
async function* g() { yield* [1, 2, 3]; }
(async function () {
  try { for await (const v of g()) log.push(v); } catch (e) { log.push('E:' + e.message); }
  // for-await over a sync iterable of promises
  for await (const v of [Promise.resolve(4), 5]) log.push(v);
  // explicit sync iterator object with next only
  const it = { i: 0, [Symbol.iterator]() { return this; }, next() { return { value: this.i, done: this.i++ >= 2 }; } };
  async function* h() { const r = yield* it; log.push('r=' + r); }
  try { for await (const v of h()) log.push('h' + v); } catch (e) { log.push('E2:' + e.message); }
  report(JSON.stringify(log));
})();
