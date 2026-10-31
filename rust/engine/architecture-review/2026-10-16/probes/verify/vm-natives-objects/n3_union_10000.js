const a = new Set(), b = new Set(); for (let i = 0; i < 10000; i++) { a.add(i); b.add(i + 10000); }
const u = a.union(b);
throw new Error(JSON.stringify([u.size]));
