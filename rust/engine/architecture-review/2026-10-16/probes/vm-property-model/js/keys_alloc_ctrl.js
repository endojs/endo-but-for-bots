// control for keys_alloc.js: same number of fresh strings, no Object.keys
var n = 0;
try { for (var r = 0; r < 2000; r++) { var a = new Array(20000); for (var i = 0; i < 20000; i++) a[i] = 'key_number_' + i; n += a.length; } }
catch (e) { throw new Error('threw after ' + n + ': ' + e.name); }
throw new Error('done ' + n);
