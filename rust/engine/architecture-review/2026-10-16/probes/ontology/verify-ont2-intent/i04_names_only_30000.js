const o = {}; let i = 0, err = "none";
try { for (; i < 30000; i++) o["k" + i] = i; } catch (e) { err = String(e); }
throw new Error("names minted=" + i + " | " + err);
