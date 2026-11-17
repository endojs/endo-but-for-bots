const r = [];
try { r.push(JSON.parse('['.repeat(3000) + ']'.repeat(3000)).length); } catch (e) { r.push('parse:' + e.name); }
let v = 1; for (let i = 0; i < 3000; i++) v = [v];
try { r.push(JSON.stringify(v).length); } catch (e) { r.push('stringify:' + e.name); }
throw new Error(JSON.stringify(r));
