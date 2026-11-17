const log = [];
function broken() { const p = Promise.resolve(42); Object.defineProperty(p, 'constructor', { get() { throw new Error('broken'); } }); return p; }
(async function () { try { const v = await broken(); log.push('await fulfilled ' + v); } catch (e) { log.push('await threw ' + e.message); } })();
async function* g() {}
g().return(broken()).then(function (r) { log.push('gen.return fulfilled ' + JSON.stringify(r)); }, function (e) { log.push('gen.return rejected ' + e.message); });
const it = g(); it.next(); 
after(10, function () { it.return(broken()).then(function (r) { log.push('completed gen.return fulfilled ' + JSON.stringify(r)); }, function (e) { log.push('completed gen.return rejected ' + e.message); }); });
after(20, function () { report(JSON.stringify(log)); });
