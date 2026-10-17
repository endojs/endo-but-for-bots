// Dense sort of 40000 (succeeds), then 30000 distinct computed names.
const a = []; for (let i = 0; i < 40000; i++) a.push(40000 - i);
let s; try { s = "sort ok " + a.sort((x, y) => x - y)[0]; } catch (e) { s = "sort " + e; }
const o = {}; let i = 0, err = "none";
try { for (; i < 30000; i++) o["k" + i] = i; } catch (e) { err = String(e); }
throw new Error(s + " | names minted=" + i + " | " + err);
