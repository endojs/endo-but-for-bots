let r = "start";
try { new WeakSet([Symbol.for("x")]); r = "ok"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
