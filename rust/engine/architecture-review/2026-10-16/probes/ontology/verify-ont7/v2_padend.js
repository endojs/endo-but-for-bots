let r;
try { r = "padEnd:" + "x".padEnd(2 ** 24 + 1, "x").length; } catch (e) { r = "caught " + e; } finally { r += " +finally"; }
throw new Error(r);
