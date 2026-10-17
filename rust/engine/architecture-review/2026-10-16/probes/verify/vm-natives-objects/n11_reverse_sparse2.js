const r = [];
for (const n of [2 ** 25, 2 ** 17, 70000]) {
  const a = []; a.length = n; a[0] = 2; a[1] = 1;
  try { a.reverse(); r.push(n + ' ok ' + a[n - 1]); } catch (e) { r.push(n + ' ' + e.name + ': ' + e.message); }
}
const b = []; b.length = 70000; b[0] = 2; b[1] = 1;
try { b.sort(); r.push('sort70k ok ' + b[0]); } catch (e) { r.push('sort70k ' + e.message); }
throw new Error(JSON.stringify(r));
