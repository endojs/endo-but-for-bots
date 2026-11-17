var s = 'x'.repeat(100000); var a = []; for (var i = 0; i < 2000; i++) a.push(s); var n = 0; a.sort(function (x, y) { n++; return x < y ? -1 : x > y ? 1 : 0; });
throw new Error(JSON.stringify([a.length, n]));
