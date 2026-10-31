const r = [];
r.push('a'.repeat(2 ** 25).length);
try { r.push(''.padStart(2 ** 25, 'a').length); } catch (e) { r.push(e.name); }
throw new Error(JSON.stringify(r));
