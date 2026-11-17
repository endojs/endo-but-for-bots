// obj['k'+i] = i for i < 70000
var o = {}; var n = 0;
try { for (var i = 0; i < 70000; i++) { o['k' + i] = i; n++; } }
catch (e) { throw new Error('caught at ' + n + ': ' + e.name + ': ' + e.message); }
throw new Error('done ' + n);
