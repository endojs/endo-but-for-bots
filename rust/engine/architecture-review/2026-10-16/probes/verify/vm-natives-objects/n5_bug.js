const r = [];
for (const [n, len] of [[10, 10], [1000, 10], [10, 100000], [100, 1000], [1000, 1000], [2, 100000]]) {
  const s = 'x'.repeat(len);
  const a = []; for (let i = 0; i < n; i++) a.push(s);
  try { a.sort(); r.push(n + "x" + len + " ok"); } catch (e) { r.push(n + "x" + len + " " + e.message); }
}
throw new Error(JSON.stringify(r));
