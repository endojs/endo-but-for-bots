function tag(s) { return s; }
var i = 0, err = "none";
try { for (i = 0; i < 80000; i++) eval("tag('x')"); }
catch (e) { err = e.name + ": " + e.message; }
var after = "n/a";
try { var o = {}; o["fresh_key_after_" + i] = 1; after = "ok"; } catch (e) { after = e.name + ": " + e.message; }
throw new Error("evals=" + i + " err=" + err + " | new key afterwards: " + after);
