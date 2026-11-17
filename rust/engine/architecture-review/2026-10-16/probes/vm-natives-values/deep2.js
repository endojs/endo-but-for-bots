let r = [];
let v = []; for (let i = 0; i < 3000; i++) v = [v];
try { r.push(JSON.stringify(v).length); } catch (e) { r.push(e.name); }
throw new Error(JSON.stringify(r));
