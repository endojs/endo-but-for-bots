const r = [];
const m = new Map([[1, 2]]); const s = new Set([3]);
const cases = [
  () => Reflect.apply(Map.prototype.forEach, m, [() => {}]),
  () => Map.prototype.forEach.call(m, () => {}),
  () => Function.prototype.call.call(Map.prototype.keys, m).next().value,
  () => Map.prototype.keys.bind(m)().next().value,
  () => Array.from(m).length,
  () => [...s].length,
  () => new Map(m).size,
  () => new Set(s).size,
  () => Reflect.apply(Set.prototype.values, s, []).next().value,
  () => Set.prototype.clear.apply(s, []),
  () => new Proxy(Map.prototype.entries, {}).call(m).next().value,
  () => Array.from({ [Symbol.iterator]: Map.prototype.entries.bind(m) }).length,
];
for (const c of cases) { try { r.push(String(c())); } catch (e) { r.push(e.name); } }
throw new Error(JSON.stringify(r));
