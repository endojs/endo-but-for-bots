const t = new Int32Array(10000); for (let i = 0; i < 10000; i++) t[i] = 10000 - i;
t.sort();
if (t[0] !== 1) throw new Error('bad');
