(function () { Promise.reject(1); })();
(function () { new Promise(function (_, rej) { rej(2); }); })();
var junk;
for (var i = 0; i < 400000; i++) junk = { i: i, s: "x" + i };
"done";
