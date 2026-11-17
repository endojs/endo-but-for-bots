var a = []; for (var i = 0; i < 100000; i++) a.push(i); function f() { return arguments.length; } var m = f(...a); throw new Error("len=" + m);
