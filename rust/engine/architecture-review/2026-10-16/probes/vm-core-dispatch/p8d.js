var log = []; function L(x) { log.push(x); }
(async function () { var v = await Promise.resolve(1); L("aw-" + v); var w = await { then: function (r) { r(2); } }; L("aw-" + w); })();
Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); }).then(function () { L("p4"); }).then(function () { L("p5"); });
