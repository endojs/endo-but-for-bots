let r;
try { r = "padEnd:" + "x".padEnd(2 ** 31, "x").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
