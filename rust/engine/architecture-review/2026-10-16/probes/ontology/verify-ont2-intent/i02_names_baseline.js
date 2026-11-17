// Fresh realm: how many distinct computed string names can a guest mint?
const o = {}; let i = 0, err = "none";
try { for (; i < 80000; i++) o["k" + i] = i; } catch (e) { err = String(e); }
throw new Error("names minted=" + i + " | " + err);
