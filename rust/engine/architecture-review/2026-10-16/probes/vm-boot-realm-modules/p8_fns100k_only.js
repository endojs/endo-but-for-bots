var fns = [];
for (var i = 0; i < 100000; i++) fns.push(function () {});
var o = {};
for (var j = 0; j < 20000; j++) o[j] = j;
