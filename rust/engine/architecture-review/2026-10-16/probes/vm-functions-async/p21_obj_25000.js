const keep = [];
const never = new Promise(function () {});
function exec() {}
function h() {}
async function af(x) { await never; return x; }
function* gf(x) { yield x; yield x; }
for (let i = 0; i < 25000; i++) { keep.push({ a: i, b: i }); }
