var log = [];
function L(x) { log.push(x); }
(async function a1() { L("a1-start"); await null; L("a1-after-await"); try { await Promise.reject("rj"); } catch (e) { L("a1-caught-" + e); } finally { L("a1-finally"); } return "a1-done"; })().then(function (v) { L(v); });
Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); });
(async function a2() { try { L("a2-start"); return "r"; } finally { L("a2-fin"); await null; L("a2-fin-after"); } })().then(function (v) { L("a2-res-" + v); });
var thenable = { then: function (r) { L("thenable-then"); r("T"); } };
(async function a3() { var v = await thenable; L("a3-" + v); })();
(async function a4() { for await (var x of [Promise.resolve(1), 2]) L("fa-" + x); })();
async function* ag() { try { yield 1; yield 2; } finally { L("ag-fin"); } }
(async function a5() { for await (var x of ag()) { L("ag-" + x); break; } })();
new Promise(function (res) { L("executor"); res(Promise.resolve("nested")); }).then(function (v) { L("resolved-with-promise-" + v); });
Promise.all([1, Promise.resolve(2)]).then(function (v) { L("all-" + v.join("+")); });
Promise.race([new Promise(function () {}), Promise.resolve("race")]).then(function (v) { L("race-" + v); });
Promise.allSettled([Promise.reject("x")]).then(function (v) { L("settled-" + v[0].status); });
Promise.any([Promise.reject(1)]).catch(function (e) { L("any-" + e.name + e.errors.length); });
(async () => { await undefined; L("arrow-async"); })();
L("sync-end");
var EXPECTED = ["a1-start","a2-start","a2-fin","executor","sync-end","a1-after-await","p1","a2-fin-after","thenable-then","arrow-async","a1-caught-rj","a1-finally","p2","a2-res-r","a3-T","fa-1","ag-1","all-1+2","race-race","settled-rejected","any-AggregateError1","a1-done","p3","ag-fin","resolved-with-promise-nested","fa-2"];
function finish() { if (JSON.stringify(log) !== JSON.stringify(EXPECTED)) { (function r() { r(); })(); } }
var chain = Promise.resolve(); for (var i = 0; i < 40; i++) chain = chain.then(function () {}); chain.then(finish);
