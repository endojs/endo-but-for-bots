const out = [];
const a = []; for (let i = 0; i < 70000; i++) a.push(70000 - i);
try { a.sort((x, y) => x - y); out.push("sort ok " + a[0]); } catch (e) { out.push("sort " + e.name + ": " + e.message); }
const b = []; for (let i = 0; i < 70000; i++) b.push(i);
try { b.toSorted((x, y) => y - x); out.push("toSorted ok"); } catch (e) { out.push("toSorted " + e.name); }
throw new Error(JSON.stringify(out));
