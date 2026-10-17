const t = new Int8Array([3, 1, 2]);
const r = {};
for (const m of ['toSorted', 'toReversed', 'with']) r[m] = typeof t[m];
throw new Error(JSON.stringify(r));
