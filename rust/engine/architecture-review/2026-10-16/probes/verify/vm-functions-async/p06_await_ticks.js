const log = [];
function ticker(prefix, n) { let p = Promise.resolve(); for (let i = 1; i <= n; i++) { const k = i; p = p.then(function () { log.push(prefix + k); }); } }
// A: await native promise (1 tick), await thenable (2 ticks), await non-promise (1 tick)
(async function () { await Promise.resolve(); log.push('A-native'); })();
(async function () { await { then(r) { r(); } }; log.push('A-thenable'); })();
(async function () { await 1; log.push('A-value'); })();
// B: async return of a native promise: 3 ticks in spec
(async function () { return Promise.resolve(); })().then(function () { log.push('B-return-promise'); });
(async function () { return 1; })().then(function () { log.push('B-return-value'); });
ticker('t', 6);
after(30, function () { report(JSON.stringify(log)); });
