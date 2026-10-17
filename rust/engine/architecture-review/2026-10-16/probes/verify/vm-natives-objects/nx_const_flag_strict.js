'use strict';
const r = [];
function collect(n) { const out = []; for (let i = 0; i < n; i++) { const v = i * 10; out.push(v); } return out; }
const a = collect(3);
r.push(JSON.stringify(Object.getOwnPropertyDescriptors(a)[0]));
try { a[0] = 99; r.push('assign ok ' + a[0]); } catch (e) { r.push('assign ' + e.name + ': ' + e.message); }
try { a.sort((x, y) => y - x); r.push('sort ok ' + a.join()); } catch (e) { r.push('sort ' + e.name + ': ' + e.message); }
throw new Error(JSON.stringify(r));
