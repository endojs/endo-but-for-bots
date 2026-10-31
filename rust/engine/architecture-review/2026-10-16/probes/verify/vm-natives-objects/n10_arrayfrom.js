const N = 1000005;
const a = []; for (let i = 0; i < N; i++) a.push(i);
let r;
try { r = Array.from(a.values()).length; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['arrayfrom', r]));
