const t = new Int32Array(10000); for (let i = 0; i < 10000; i++) t[i] = 10000 - i;
t.sort();
throw new Error(JSON.stringify([t[0], t[10000 - 1]]));
