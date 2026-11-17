const s = new Set([1, 2, 3]); const seen = [];
for (const k of s) { seen.push(k); if (k === 1) { s.clear(); s.add(9); } }
const m = new Map([[1, 1], [2, 2]]); const seen2 = [];
m.forEach((v, k) => { seen2.push(k); if (k === 1) { m.clear(); m.set(7, 7); } });
const s3 = new Set([1, 2, 3]); const seen3 = [];
for (const k of s3) { seen3.push(k); if (k === 1) { s3.delete(1); s3.delete(2); s3.delete(3); s3.add(9); } }
throw new Error(JSON.stringify([seen.join(), seen2.join(), seen3.join()]));
