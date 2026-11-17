// Object.keys allocates a fresh string chunk per key per call (no key-string sharing)
var parts = []; for (var i = 0; i < 20000; i++) parts.push('"key_number_' + i + '":' + i);
var o = JSON.parse('{' + parts.join(',') + '}');
var n = 0;
try { for (var r = 0; r < 2000; r++) { var ks = Object.keys(o); n += ks.length; } }
catch (e) { throw new Error('threw after ' + n + ' keys: ' + e.name); }
throw new Error('done ' + n);
