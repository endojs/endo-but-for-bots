const N = 1000005;
const a = []; for (let i = 0; i < N; i++) a.push(i);
let r;
try { r = new Set(a.values()).size; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['set', r]));
