const G = 7;
const r = [];
function w(name, a, k) { const d = Object.getOwnPropertyDescriptor(a, k); r.push(name + ":" + (d ? d.writable + "/" + d.configurable : "none")); }
function t(name, f) { try { f(); } catch (e) { r.push(name + ":" + e.name + " " + e.message); } }
t("push", () => { const s = 'xx'; const a = []; a.push(s); w("push", a, 0); });
t("push-num", () => { const s = 5; const a = []; a.push(s); w("push-num", a, 0); });
t("push-letlocal", () => { let s = 5; const a = []; a.push(s); w("push-let", a, 0); });
t("push-global-const", () => { const a = []; a.push(G); w("push-global-const", a, 0); });
t("unshift", () => { const s = 'xx'; const a = []; a.unshift(s); w("unshift", a, 0); });
t("splice", () => { const s = 'xx'; const a = [1]; a.splice(0, 0, s); w("splice", a, 0); });
t("of", () => { const s = 'xx'; const a = Array.of(s); w("of", a, 0); });
t("lit", () => { const s = 'xx'; const a = [s]; w("lit", a, 0); });
t("ctor", () => { const s = 'xx'; const a = new Array(s, s); w("ctor", a, 0); });
t("concat", () => { const s = 'xx'; const a = [].concat(s); w("concat", a, 0); });
t("fill", () => { const s = 'xx'; const a = [1]; a.fill(s); w("fill", a, 0); });
t("with", () => { const s = 'xx'; const a = [1].with(0, s); w("with", a, 0); });
t("objset", () => { const s = 'xx'; const o = {}; o.k = s; w("objset", o, 'k'); });
t("defprop", () => { const s = 'xx'; const o = {}; Reflect.set(o, 'k', s); w("reflectset", o, 'k'); });
t("mapset", () => { const s = 'xx'; const m = new Map(); m.set(s, s); r.push("map:" + [...m.keys()].join()); });
throw new Error(JSON.stringify(r));
