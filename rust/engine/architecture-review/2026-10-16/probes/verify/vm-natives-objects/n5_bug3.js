const r = [];
function t(name, f) { try { r.push(name + ":" + f()); } catch (e) { r.push(name + ":" + e.name + " " + e.message); } }
t("assign", () => { const a = []; for (let i = 0; i < 3; i++) a.push(i); a[0] = 9; return a.join(); });
t("desc", () => { const a = []; for (let i = 0; i < 3; i++) a.push(i); return JSON.stringify(Object.getOwnPropertyDescriptor(a, 0)); });
t("reverse", () => { const a = []; for (let i = 0; i < 3; i++) a.push(i); return a.reverse().join(); });
t("sortnum", () => { const a = []; for (let i = 0; i < 3; i++) a.push(3 - i); return a.sort().join(); });
t("sortcmp", () => { const a = []; for (let i = 0; i < 3; i++) a.push(3 - i); return a.sort((x, y) => x - y).join(); });
t("sort-noclosure", () => { const a = []; let i = 0; for (; i < 3; i++) a.push(3 - i); return a.sort().join(); });
t("sort-while", () => { const a = []; let i = 0; while (i < 3) { a.push(3 - i); i++; } return a.sort().join(); });
t("sort-topconst", () => { const a = [3,2,1]; return a.sort().join(); });
throw new Error(JSON.stringify(r));
