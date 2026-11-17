// Symbols as WeakMap/WeakSet keys via the METHODS (not the constructor).
const out = [];
for (const [name, f] of [
  ["WeakMap.set", () => new WeakMap().set(Symbol("a"), 1).has],
  ["WeakSet.add", () => new WeakSet().add(Symbol("b")).has],
  ["WeakRef", () => new WeakRef(Symbol("c")).deref],
  ["FinReg.register", () => new FinalizationRegistry(() => {}).register(Symbol("d"), 1)],
  ["WeakMap.set registered", () => new WeakMap().set(Symbol.for("e"), 1)],
]) {
  try { f(); out.push(name + ":ok"); } catch (e) { out.push(name + ":" + e.name); }
}
throw new Error(out.join(" | "));
