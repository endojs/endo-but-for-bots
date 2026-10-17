const out = [];
for (const [name, f] of [
  ["Array.from-arraylike", () => Array.from({ length: 70000 }, (_, i) => i).length],
  ["sort-holey", () => { const a = new Array(70000); for (let i = 0; i < 70000; i += 2) a[i] = 70000 - i; return a.sort((x, y) => x - y).length; }],
]) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":caught " + e); }
}
throw new Error(out.join(" | "));
