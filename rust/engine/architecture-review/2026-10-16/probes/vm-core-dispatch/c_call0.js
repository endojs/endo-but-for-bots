(function () { function f(a) { return a; } var s = 0; for (var i = 0; i < 200000; i++) { s = s + f(i); } })();
