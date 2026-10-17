const d = Temporal.PlainDate.from('2021-01-31'); const e = d.add({ days: 1000000 });
const u = e.until(d, { largestUnit: 'months' });
throw new Error(JSON.stringify([String(e), String(u), u.months, u.days, String(d.until(e, { largestUnit: 'months' })), String(d.until(e, { largestUnit: 'years' }))]));
