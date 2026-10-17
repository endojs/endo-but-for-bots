var a = []; for (var i = 0; i < 1000000; i++) a.push(i);
var m = Math.max(...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a, ...a);
throw new Error("max=" + m);
