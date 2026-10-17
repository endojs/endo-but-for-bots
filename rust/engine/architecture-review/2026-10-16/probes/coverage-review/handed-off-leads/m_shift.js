var a = []; for (var i = 0; i < 10000; i++) a.push(i); var t = 0; while (a.length) t += a.shift(); if (t !== 49995000) throw new Error(String(t));
