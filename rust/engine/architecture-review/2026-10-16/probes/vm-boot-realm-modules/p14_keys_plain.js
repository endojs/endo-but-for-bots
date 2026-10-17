// 100,000 Object.keys calls on a one-key plain object.
var o = { a: 1 }; var n = 0;
for (var i = 0; i < 100000; i++) n += Object.keys(o).length;
