const r = [];
try { const a = []; a.length = 2**24 + 1; a.with(0, 1); r.push('ok'); } catch (e) { r.push(e.name); }
throw new Error(JSON.stringify(r));
