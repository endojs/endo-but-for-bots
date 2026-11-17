// for-in over one object whose single key is 100,000 characters, 2,000 times.
const k = 'k'.repeat(100000);
const o = {}; o[k] = 1;
let n = 0;
for (let i = 0; i < 2000; i++) { for (const key in o) n += key.length; }
throw new Error('completed ' + n);
