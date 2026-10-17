function f(a) { let x = a; { let y = x + 1; { let z = y + 1; return z; } } }
var s = 0; for (var i = 0; i < 2000000; i++) { s = s + f(i); }
