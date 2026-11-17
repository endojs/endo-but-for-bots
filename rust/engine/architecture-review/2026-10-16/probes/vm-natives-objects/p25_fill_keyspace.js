const r = [];
try { new Array(70000).fill(0); r.push('70k ok'); } catch (e) { r.push('70k ' + e.name); }
throw new Error(JSON.stringify(r));
