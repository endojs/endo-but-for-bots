const out = [];
function t(n, f) { try { f(); out.push(n + ":ok"); } catch (e) { out.push(n + ":" + e.name); } }
t("ctor-number-dense", () => new WeakMap([[1, 1]]));
t("ctor-map-iterable", () => new WeakMap(new Map([[Symbol("a"), 1]])));
t("set", () => new WeakMap().set(Symbol("b"), 1));
throw new Error(out.join(" | "));
