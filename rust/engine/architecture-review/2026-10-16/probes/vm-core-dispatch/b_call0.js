function f(a) { return a; }
var s = 0; for (var i = 0; i < 2000000; i++) { s = s + f(i); }
