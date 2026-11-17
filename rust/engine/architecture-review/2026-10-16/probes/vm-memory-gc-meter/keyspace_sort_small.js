var a = []; for (var i = 0; i < 70000; i++) a.push((i * 7919) % 100003);
a.sort();
throw new Error("completed " + a[0]);
