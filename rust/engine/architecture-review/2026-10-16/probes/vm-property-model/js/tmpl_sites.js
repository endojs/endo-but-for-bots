// Each evaluated tagged-template site: does it consume a key id forever?
function tag(s) { return s; }
var n = 0;
try { for (var i = 0; i < 70000; i++) { (0, eval)('tag`x`'); n++; } }
catch (e) { throw new Error('caught at ' + n + ': ' + e.name + ': ' + e.message); }
throw new Error('done ' + n);
