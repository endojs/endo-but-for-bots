const log = [];
function ticker(prefix, n) { let p = Promise.resolve(); for (let i = 1; i <= n; i++) { const k = i; p = p.then(function () { log.push(prefix + k); }); } }
async function* g1() {}
async function* g2() { return; }
async function* g3() { yield 1; }
g1().next().then(function () { log.push('g1 implicit'); });
g2().next().then(function () { log.push('g2 explicit'); });
g3().next().then(function () { log.push('g3 yield'); });
ticker('t', 5);
after(20, function () { report(JSON.stringify(log)); });
