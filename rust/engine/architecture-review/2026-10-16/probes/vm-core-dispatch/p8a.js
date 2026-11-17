var log = []; function L(x) { log.push(x); }
(async function () { for await (var x of [Promise.resolve(1), 2]) L("fa-" + x); L("fa-end"); })();
Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); }).then(function () { L("p4"); }).then(function () { L("p5"); });
