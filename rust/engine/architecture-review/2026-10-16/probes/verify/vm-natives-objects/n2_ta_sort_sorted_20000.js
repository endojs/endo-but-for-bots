const t = new Int32Array(20000); for (let i = 0; i < 20000; i++) t[i] = i;
t.sort();
throw new Error(JSON.stringify([t[0], t[20000 - 1]]));
