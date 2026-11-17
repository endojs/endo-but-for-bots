function f() { return arguments.length; }
var a = []; for (var i = 0; i < 100000; i++) a.push(i);
var n = 0;
for (var j = 0; j < 20; j++) n += f(...a);
throw new Error("completed " + n);
