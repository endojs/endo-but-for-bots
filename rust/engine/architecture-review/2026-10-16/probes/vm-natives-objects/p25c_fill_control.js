const r = [];
let made = 0;
try { const o = {}; for (let i = 0; i < 30000; i++) { o['p' + i] = i; made++; } r.push('30k names ok'); } catch (e) { r.push('names failed after ' + made + ' ' + e.name); }
throw new Error(JSON.stringify(r));
