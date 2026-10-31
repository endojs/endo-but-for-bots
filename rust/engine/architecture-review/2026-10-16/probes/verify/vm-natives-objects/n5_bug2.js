const r = [];
function t(name, f) { try { r.push(name + ":" + f()); } catch (e) { r.push(name + ":" + e.name + " " + e.message); } }
t("lit", () => ['b', 'a'].sort().join());
t("pushed", () => { const a = []; a.push('b'); a.push('a'); return a.sort().join(); });
t("pushed-same", () => { const a = []; a.push('x'); a.push('x'); return a.sort().join(); });
t("lit-same", () => ['x', 'x'].sort().join());
t("repeat-same", () => { const s = 'x'.repeat(3); const a = [s, s]; return a.sort().join(); });
t("loop", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.sort().join(); });
t("loop-var", () => { var s = 'xx'; var a = []; for (var i = 0; i < 3; i++) a.push(s); return a.sort().join(); });
throw new Error(JSON.stringify(r));
