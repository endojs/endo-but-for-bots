const t = new Int32Array(40000); for (let i = 0; i < 40000; i++) t[i] = i;
t.sort();
throw new Error(JSON.stringify([t[0], t[40000 - 1]]));
