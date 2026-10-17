const t = new Int32Array(40000); for (let i = 0; i < 40000; i++) t[i] = 40000 - i;
t.sort();
if (t[0] !== 1) throw new Error('bad');
