const keep = [];
const never = new Promise(function () {});
function exec() {}
function h() {}
async function af(x) { await never; return x; }
function* gf(x) { yield x; yield x; }
for (let i = 0; i < 0; i++) { const p = new Promise(exec); p.then(h); keep.push(p); }
