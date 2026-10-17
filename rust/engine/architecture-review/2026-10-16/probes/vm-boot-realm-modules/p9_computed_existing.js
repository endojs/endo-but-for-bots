// 20,000 computed writes of ONE already-interned key: the pass is skipped.
var p = {};
for (var i = 0; i < 20000; i++) p["k" + (i % 1)] = i;
