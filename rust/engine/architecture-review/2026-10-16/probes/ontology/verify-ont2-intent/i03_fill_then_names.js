// A SUCCESSFUL 40000 holey fill, then 30000 distinct computed names.
let f = "fill ok";
try { new Array(40000).fill(0); } catch (e) { f = "fill " + e; }
const o = {}; let i = 0, err = "none";
try { for (; i < 30000; i++) o["k" + i] = i; } catch (e) { err = String(e); }
throw new Error(f + " | names minted=" + i + " | " + err);
