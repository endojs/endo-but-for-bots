// Await performs PromiseResolve(%Promise%, v), which reads v.constructor.
var log = [];
var p = (async function () {})();
Object.defineProperty(p, "constructor", { get: function () { log.push("constructor read"); return Promise; } });
(async function () { await p; })();
throw new Error(JSON.stringify(log));
