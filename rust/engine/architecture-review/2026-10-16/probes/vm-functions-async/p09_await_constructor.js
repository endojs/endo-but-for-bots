const log = [];
function ticker(prefix, n) { let p = Promise.resolve(); for (let i = 1; i <= n; i++) { const k = i; p = p.then(function () { log.push(prefix + k); }); } }
const p = Promise.resolve(1);
let reads = 0;
Object.defineProperty(p, 'constructor', { get() { reads++; return Promise; } });
(async function () { await p; log.push('await reads=' + reads); })();
class Sub extends Promise {}
const s = Sub.resolve(2);
(async function () { await s; log.push('await-subclass'); })();
ticker('t', 5);
after(20, function () { report(JSON.stringify(log)); });
