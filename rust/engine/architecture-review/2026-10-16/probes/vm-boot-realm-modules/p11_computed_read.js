// 200,000 computed reads of one interned, non-index key held in a variable.
var p = { k: 1 }; var k = "k"; var s = 0;
for (var i = 0; i < 200000; i++) s += p[k];
