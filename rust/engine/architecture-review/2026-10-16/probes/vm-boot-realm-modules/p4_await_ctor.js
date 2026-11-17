// `await` of a native promise reads its `constructor` (PromiseResolve). The
// program never spells that name, so the intrinsic member may be pending.
var log = [];
var p = (async function () {})();
(async function () { await p; log.push("A"); })();
(async function () { await null; log.push("B1"); await null; log.push("B2"); await null; log.push("B3"); await null; log.push("B4"); })();
(async function () { for (var i = 0; i < 8; i++) await null; var e = new Error(JSON.stringify(log)); throw e; })().then(undefined, function (e) { throw e; });
