// same number of novel names, but spread over 1000-key objects
var o;
for (var i = 0; i < 32000; i++) { if (i % 1000 === 0) o = {}; o['k' + i] = i; }
