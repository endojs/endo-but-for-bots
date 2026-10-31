// Retain host memory via bound-argument vectors: few slots, many Slot copies.
function f() {}
var a = []; for (var i = 0; i < 100000; i++) a.push(i);
var bs = [];
for (var j = 0; j < 200; j++) bs.push(f.bind(null, ...a));
throw new Error("completed " + bs.length);
