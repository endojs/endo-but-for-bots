const N = 1000005;
const a = []; for (let i = 0; i < N; i++) a.push(i);
let r;
try { r = Object.keys(Object.groupBy(a.values(), x => x)).length; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['groupby', r]));
