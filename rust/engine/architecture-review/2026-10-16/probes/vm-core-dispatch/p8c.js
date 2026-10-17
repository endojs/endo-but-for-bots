var log = []; function L(x) { log.push(x); }
async function* ag() { try { yield 1; yield 2; } finally { L("ag-fin"); } }
(async function a5() { for await (var x of ag()) { L("ag-" + x); break; } L("a5-end"); })();
Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); }).then(function () { L("p4"); }).then(function () { L("p5"); }).then(function () { L("p6"); }).then(function () { L("p7"); });
