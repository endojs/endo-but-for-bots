let r;
try { r = "repeat:" + "a".repeat(200 * 1024 * 1024).length; } catch (e) { r = "caught " + e; }
throw new Error(r);
