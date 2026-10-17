const n = 2 ** 24 + 1;
let r; try { r = "padEnd:" + "x".padEnd(n, "x").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
