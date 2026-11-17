let r;
try { r = "padEnd:" + "x".padEnd(2 ** 24 + 1, "x").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
