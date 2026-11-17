var a = []; for (var i = 0; i < 100000; i++) a.push(i); var m = [...a, ...a].length; throw new Error("len=" + m);
