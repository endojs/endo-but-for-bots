const a = new Set(), b = new Set(); for (let i = 0; i < 40000; i++) { a.add(i); b.add(i + 40000); }
const u = a.union(b); if (u.size !== 2 * 40000) throw new Error('bad');
