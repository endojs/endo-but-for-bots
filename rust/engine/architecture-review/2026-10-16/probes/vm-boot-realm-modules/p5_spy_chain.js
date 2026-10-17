// A logging Proxy placed under an intrinsic prototype sees every [[Get]] that
// misses that prototype. The program never spells the members natives read.
function spy(tag, log) {
  return new Proxy({}, { get: function (t, k) { log.push(tag + ":" + String(k)); return undefined; } });
}
var log = [];
var p = (async function () {})();
Object.setPrototypeOf(Promise.prototype, spy("Promise", log));
(async function () { await p; })();                 // PromiseResolve reads p.constructor
Object.setPrototypeOf(Array.prototype, spy("Array", log));
[1, 2].splice(0, 1);                                // ArraySpeciesCreate reads constructor
Object.setPrototypeOf(RegExp.prototype, spy("RegExp", log));
"a".replace(/a/, "b");                              // RegExpExec reads exec
throw new Error(JSON.stringify(log));
