// Object.keys over the same object, 2,000 times, for comparison.
const k = 'k'.repeat(100000);
const o = {}; o[k] = 1;
let n = 0;
for (let i = 0; i < 2000; i++) { n += Object.keys(o)[0].length; }
throw new Error('completed ' + n);
