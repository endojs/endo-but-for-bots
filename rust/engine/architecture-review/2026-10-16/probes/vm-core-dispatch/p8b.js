var log = []; function L(x) { log.push(x); }
new Promise(function (res) { res(Promise.resolve("nested")); }).then(function (v) { L("rp-" + v); });
Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); }).then(function () { L("p4"); }).then(function () { L("p5"); });
