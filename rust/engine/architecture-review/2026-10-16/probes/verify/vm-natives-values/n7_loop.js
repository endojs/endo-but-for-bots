const d = Temporal.PlainDate.from('2021-01-31');
let s = 0; for (let i = 0; i < 20000; i++) { s += d.add({ days: 1000000 }).until(d, { largestUnit: 'months' }).months; }
throw new Error(String(s));
