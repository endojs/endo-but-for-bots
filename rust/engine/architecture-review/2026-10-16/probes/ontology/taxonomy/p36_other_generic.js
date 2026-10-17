// Other generic-path Array methods over a large holey array (each in a fresh realm would be cleaner;
// here each runs on its own array, in sequence, guarded).
const out = [];
for (const [name, f] of [
  ["reverse", () => new Array(140000).reverse().length],
  ["splice", () => { const a = new Array(140000); a[0] = 1; a.splice(0, 1); return a.length; }],
  ["unshift", () => { const a = new Array(140000); a[139999] = 1; a.unshift(0); return a.length; }],
]) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":caught " + e); }
}
throw new Error(out.join(" | "));
