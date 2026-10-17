var args = { length: 1000000 };
function t() {}
var keep = [];
for (var j = 0; j < N; j++) keep.push(Function.prototype.bind.apply(t, args));
throw new Error('done bound=' + keep.length + ' len=' + keep[keep.length - 1].length);
