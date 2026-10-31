var a = []; for (var i = 0; i < 100000; i++) a.push(i); var m = String.fromCharCode.apply(null, a).length; throw new Error("len=" + m);
