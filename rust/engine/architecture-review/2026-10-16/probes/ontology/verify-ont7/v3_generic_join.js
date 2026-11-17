let r;
try { r = "join:" + Array.prototype.join.call({ length: 2 ** 24 + 1, 0: "x" }, "").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
