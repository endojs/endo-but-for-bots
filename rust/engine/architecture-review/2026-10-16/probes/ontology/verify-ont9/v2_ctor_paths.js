const out = [];
function t(name, f) { try { f(); out.push(name + ":ok"); } catch (e) { out.push(name + ":" + e.name); } }
// non-dense / non-array iterables take the adder-calling slow path
t("WeakMap(new Map)", () => new WeakMap(new Map([[Symbol("a"), 1]])));
t("WeakSet(new Set)", () => new WeakSet(new Set([Symbol("b")])));
t("WeakMap(gen)", () => new WeakMap((function* () { yield [Symbol("c"), 1]; })()));
t("WeakMap(holey)", () => { const a = [[Symbol("d"), 1], , ]; new WeakMap(a); });
t("WeakMap.set", () => new WeakMap().set(Symbol("e"), 1));
t("WeakSet.add", () => new WeakSet().add(Symbol("f")));
t("WeakRef", () => new WeakRef(Symbol("g")));
t("FinReg.register", () => new FinalizationRegistry(() => {}).register(Symbol("h"), 1));
t("WeakMap ctor registered", () => new WeakMap(new Map([[Symbol.for("i"), 1]])));
t("WeakMap ctor number dense", () => new WeakMap([[1, 1]]));
throw new Error(out.join(" | "));
