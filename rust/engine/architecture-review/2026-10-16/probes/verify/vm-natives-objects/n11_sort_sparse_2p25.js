const a = []; a.length = 2 ** 25; a[0] = 2; a[1] = 1; a[5] = 0;
a.sort();
throw new Error(JSON.stringify([a.length, a[0], a[1], a[2], 5 in a]));
