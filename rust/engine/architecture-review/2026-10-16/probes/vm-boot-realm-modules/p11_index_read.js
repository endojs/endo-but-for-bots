// The same 200,000 reads through an index key held in a variable.
var p = { 0: 1 }; var k = 0; var s = 0;
for (var i = 0; i < 200000; i++) s += p[k];
