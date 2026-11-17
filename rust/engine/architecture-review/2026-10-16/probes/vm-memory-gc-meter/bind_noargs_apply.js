function f() {}
var a = []; for (var i = 0; i < 100000; i++) a.push(i);
var bs = [];
for (var j = 0; j < 20; j++) bs.push(Function.prototype.bind.apply(f, [null].concat(a)));
throw new Error("completed " + bs.length);
