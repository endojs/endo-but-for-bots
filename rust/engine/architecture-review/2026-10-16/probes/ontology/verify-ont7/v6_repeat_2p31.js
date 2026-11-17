let r;
try { r = "repeat:" + "x".repeat(2 ** 31).length; } catch (e) { r = "caught " + e; }
throw new Error(r);
