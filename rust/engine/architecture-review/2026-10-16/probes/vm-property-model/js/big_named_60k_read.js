var ks = []; for (var i = 0; i < 60000; i++) ks.push('k' + i);
var o = {}; for (var i = 0; i < 60000; i++) o[ks[i]] = i;
var s = 0; for (var r = 0; r < 4; r++) for (var i = 0; i < 60000; i++) s += o[ks[i]];
