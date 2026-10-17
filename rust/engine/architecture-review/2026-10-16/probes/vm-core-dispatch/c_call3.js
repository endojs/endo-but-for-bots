(function () { function f(a) { var x = a, y = x + 1, z = y + 1; return z; } var s = 0; for (var i = 0; i < 200000; i++) { s = s + f(i); } })();
