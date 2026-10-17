const log = [];
function ticker(prefix, n) { let p = Promise.resolve(); for (let i = 1; i <= n; i++) { const k = i; p = p.then(function () { log.push(prefix + k); }); } }
Promise.resolve(1).finally(function () { log.push('F-cb'); }).then(function (v) { log.push('F-then' + v); });
Promise.reject(2).finally(function () {}).catch(function (v) { log.push('F-catch' + v); });
Promise.all([Promise.resolve(1), 2]).then(function (v) { log.push('All' + v); });
Promise.race([Promise.resolve('r')]).then(function (v) { log.push('Race' + v); });
Promise.allSettled([Promise.reject(1)]).then(function (v) { log.push('AS' + v[0].status); });
Promise.any([Promise.reject(1), Promise.resolve(2)]).then(function (v) { log.push('Any' + v); });
ticker('t', 8);
after(30, function () { report(JSON.stringify(log)); });
