// A single 70,000-character line through three everyday regexps, each guarded.
const line = "x".repeat(70000);
const out = [];
for (const [name, f] of [
  ["dotstar-exec", () => /.*/.exec(line)[0].length],
  ["trim-replace", () => (" " + line + " ").replace(/^\s+|\s+$/g, "").length],
  ["split-lines", () => (line + "\n" + line).split(/\r?\n/).length],
]) {
  try { out.push(name + ":" + f()); } catch (e) { out.push(name + ":caught " + e); }
}
throw new Error(out.join(" | "));
