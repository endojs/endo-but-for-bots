var o = {}; for (var i = 0; i < 100000; i++) o[i] = i;
var s = 0; for (var r = 0; r < 4; r++) for (var i = 0; i < 100000; i++) s += o[i];
if (s !== 4 * 4999950000) throw new Error('bad ' + s);
