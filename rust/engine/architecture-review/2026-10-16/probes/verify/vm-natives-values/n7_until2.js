const d = Temporal.PlainDate.from('2021-01-31'); const e = d.add({ days: 1000000 });
throw new Error(JSON.stringify([String(d.until(e, { largestUnit: 'month' })), String(d.until(e, { largestUnit: 'months' })), String(d.until(e, { largestUnit: 'bogus' }))]));
