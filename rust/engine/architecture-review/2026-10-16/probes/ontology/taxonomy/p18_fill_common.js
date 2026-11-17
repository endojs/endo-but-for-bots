// The ubiquitous idiom: preallocate and zero-fill.
const out = [];
for (const n of [1000, 70000]) {
  try { const a = new Array(n).fill(0); out.push(n + ":ok:" + a.length + ":" + a[n - 1]); }
  catch (e) { out.push(n + ":" + e); }
}
// After the failure, is the realm's key space still usable for new names?
let r; try { const o = {}; o.brandNewPropertyName = 1; r = "new-name ok"; } catch (e) { r = "new-name " + e; }
out.push(r);
throw new Error(out.join(" | "));
