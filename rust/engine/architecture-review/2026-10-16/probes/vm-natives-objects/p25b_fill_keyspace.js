const r = [];
try { const z = new Array(40000).fill(0); r.push('40k ok ' + z.length); } catch (e) { r.push('40k ' + e.name); }
let made = 0;
try { const o = {}; for (let i = 0; i < 30000; i++) { o['p' + i] = i; made++; } r.push('30k names ok'); } catch (e) { r.push('names failed after ' + made + ' ' + e.name); }
throw new Error(JSON.stringify(r));
