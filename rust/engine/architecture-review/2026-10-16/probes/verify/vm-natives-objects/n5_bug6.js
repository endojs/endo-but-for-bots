const r = [];
function t(name, f) { try { r.push(name + ":" + f()); } catch (e) { r.push(name + ":" + e.name + " " + e.message); } }
t("str-loop-let", () => { const a = []; for (let i = 0; i < 3; i++) a.push('xx'); return a.sort().join(); });
t("str-loop-var", () => { const a = []; for (var i = 0; i < 3; i++) a.push('xx'); return a.sort().join(); });
t("num-same", () => { const a = []; for (let i = 0; i < 3; i++) a.push(7); return a.sort().join(); });
t("str-diff", () => { const a = []; for (let i = 0; i < 3; i++) a.push('x' + i); return a.sort().join(); });
t("str-2", () => { const a = []; for (let i = 0; i < 2; i++) a.push('xx'); return a.sort().join(); });
t("str-3-noloop", () => { const a = []; a.push('xx'); a.push('xx'); a.push('xx'); return a.sort().join(); });
t("num-3-noloop", () => { const a = []; a.push(7); a.push(7); a.push(7); return a.sort().join(); });
t("lit3", () => [7,7,7].sort().join());
t("lit3s", () => ['a','a','a'].sort().join());
t("lit4", () => [1,1,2,2].sort().join());
t("lit-eq-pair", () => [2,1,1].sort().join());
throw new Error(JSON.stringify(r));
