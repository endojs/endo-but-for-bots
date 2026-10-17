const out = {};
const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = "throws " + e.name + ": " + e.message; } };
t("ownGlobal", () => { const r = /a/; Object.defineProperty(r, "global", { value: "own" }); return r.global; });
t("ownSource", () => { const r = /a/; Object.defineProperty(r, "source", { value: "own" }); return r.source; });
t("subclassGetter", () => { class R extends RegExp { get global() { return "sub"; } } return new R("a").global; });
t("subclassFlags", () => { class R extends RegExp { get flags() { return "zz"; } } return new R("a", "g").flags; });
t("protoOverrideThenFlags", () => { const r = /a/g; Object.setPrototypeOf(r, { get flags() { return "proto"; } }); return r.flags; });
t("subclassFlagsUsedByReplaceAll", () => { class R extends RegExp { get flags() { return "g"; } } return "aa".replaceAll(new R("a"), "b"); });
throw new Error(JSON.stringify(out));
