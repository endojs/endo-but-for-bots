const log = [];
async function* g() { try { return Promise.reject('r'); } catch (e) { yield 'caught ' + e; } }
const it = g();
it.next().then(function (r) { log.push(JSON.stringify(r)); }, function (e) { log.push('rejected ' + e); });
async function* h() { return Promise.resolve('v'); }
h().next().then(function (r) { log.push(JSON.stringify(r)); });
after(20, function () { report(JSON.stringify(log)); });
