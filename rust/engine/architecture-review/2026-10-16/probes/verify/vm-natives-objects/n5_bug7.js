const r = [];
function t(name, f) { try { r.push(name + ":" + f()); } catch (e) { r.push(name + ":" + e.name + " " + e.message); } }
t("A", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.sort().join(); });
t("B", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.join(); });
t("C", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); a[0] = 1; return a.join(); });
t("D", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return JSON.stringify(Object.getOwnPropertyDescriptors(a)); });
t("E", () => { let s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.sort().join(); });
t("F", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) { a.push(s); } return a.reverse().join(); });
t("G", () => { const s = 1; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.sort().join(); });
t("H", () => { const s = 'xx'; const a = []; a.push(s); a.push(s); a.push(s); return a.sort().join(); });
t("I", () => { const s = 'xx'; const a = []; for (let i = 0; i < 3; i++) a.push(s); return a.fill(0).join(); });
throw new Error(JSON.stringify(r));
