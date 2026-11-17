// Step 1: an ordinary zero-fill of a preallocated array (fails partway).
let fillResult; try { new Array(70000).fill(0); fillResult = "fill ok"; } catch (e) { fillResult = "fill " + e; }
// Step 2: unrelated code that mints new property names at run time.
const out = [];
for (const make of [
  () => { const o = {}; o["k" + 12345] = 1; },
  () => JSON.parse('{"freshJsonKey": 1}'),
  () => { const m = {}; for (let i = 0; i < 10; i++) m["name_" + i] = i; },
  () => Symbol.for("fresh-registry-key"),
]) {
  try { make(); out.push("ok"); } catch (e) { out.push(String(e)); }
}
throw new Error(fillResult + " || " + out.join(" | "));
