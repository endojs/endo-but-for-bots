// The same 2**24 + 1 code-unit string, built three ways.
const n = 2 ** 24 + 1;
const out = [];
for (const [name, make] of [
  ["repeat", () => "x".repeat(n)],
  ["concat", () => "x".repeat(n - 1) + "x"],
  ["padEnd", () => "x".padEnd(n, "x")],
]) {
  try { out.push(name + ":" + make().length); } catch (e) { out.push(name + ":caught " + e); }
}
throw new Error(out.join(" | "));
