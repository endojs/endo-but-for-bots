var caught = 'none', n = 0;
try { var o = {}; for (var i = 0; i < 70000; i++) { o['k' + i] = i; n = i; } } catch (e) { caught = 'yes'; }
var x = 'after';
throw new Error(x);
