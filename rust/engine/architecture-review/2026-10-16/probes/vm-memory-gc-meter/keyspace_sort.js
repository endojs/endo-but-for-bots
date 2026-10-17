var a = []; for (var i = 0; i < 100000; i++) a.push((i * 7919) % 100003);
a.sort(function (x, y) { return x - y; });
throw new Error("completed " + a[0] + "," + a[99999]);
