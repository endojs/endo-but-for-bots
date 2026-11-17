let r;
try { r = "join:" + Array(2 ** 24 + 2).join("x").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
