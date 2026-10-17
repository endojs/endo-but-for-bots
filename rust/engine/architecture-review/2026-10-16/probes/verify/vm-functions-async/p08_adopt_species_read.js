const log = [];
const p = Promise.resolve(1);
let reads = 0;
Object.defineProperty(p, 'constructor', { get() { reads++; return Promise; } });
new Promise(function (r) { r(p); }).then(function () { log.push('constructor reads=' + reads); });
(async function () { return p; })().then(function () { log.push('async-return reads=' + reads); });
after(10, function () { report(JSON.stringify(log)); });
