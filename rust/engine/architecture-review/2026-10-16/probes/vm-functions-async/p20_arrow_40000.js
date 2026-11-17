const keep = [];
const never = new Promise(function () {});
async function af(x) { await never; return x; }
function* gf(x) { yield x; yield x; }
for (let i = 0; i < 40000; i++) { const v = i; keep.push(() => v); }
