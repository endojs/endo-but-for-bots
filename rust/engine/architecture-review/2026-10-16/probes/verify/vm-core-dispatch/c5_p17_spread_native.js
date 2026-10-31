var a = []; for (var i = 0; i < 100000; i++) a.push(i); var m = Math.max(...a); throw new Error("max=" + m);
