// Each eval naming a fresh identifier: does the compiler's symbol consume a key id forever?
var n = 0;
try { for (var i = 0; i < 70000; i++) { (0, eval)('var v' + i + ' = 1; delete globalThis.v' + i); n++; } }
catch (e) { throw new Error('caught at ' + n + ': ' + e.name + ': ' + e.message); }
throw new Error('done ' + n);
