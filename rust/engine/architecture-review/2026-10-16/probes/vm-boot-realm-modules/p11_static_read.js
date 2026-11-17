// The same 200,000 reads through a static property name.
var p = { k: 1 }; var s = 0;
for (var i = 0; i < 200000; i++) s += p.k;
