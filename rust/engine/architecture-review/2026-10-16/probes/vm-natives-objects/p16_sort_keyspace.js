const r = [];
for (const n of [1000, 30000, 60000, 70000]) {
  const a = []; for (let i = 0; i < n; i++) a.push(n - i);
  try { a.sort((x, y) => x - y); r.push(n + ':' + (a[0] === 1 && a[n - 1] === n ? 'ok' : 'wrong')); } catch (e) { r.push(n + ':' + e.name + ' ' + e.message); }
}
// after sorting, can we still create new property names?
try { const o = {}; for (let i = 0; i < 10000; i++) o['k' + i] = i; r.push('newkeys ok'); } catch (e) { r.push('newkeys ' + e.name + ' ' + e.message); }
throw new Error(JSON.stringify(r));
