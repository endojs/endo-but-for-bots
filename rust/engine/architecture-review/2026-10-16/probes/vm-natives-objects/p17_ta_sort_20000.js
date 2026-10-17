const t = new Int32Array(20000); for (let i = 0; i < 20000; i++) t[i] = 20000 - i;
t.sort();
if (t[0] !== 1) throw new Error('bad');
