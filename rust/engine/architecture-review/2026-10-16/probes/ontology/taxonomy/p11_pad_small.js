// padStart result bigger than repeat's: find the ceilings
const out = [];
for (const n of [2**20, 2**24, 2**26, 2**28]) {
  try { out.push(n + ":" + "x".repeat(n).length); } catch (e) { out.push(n + ":" + e); }
}
throw new Error(out.join(" "));
