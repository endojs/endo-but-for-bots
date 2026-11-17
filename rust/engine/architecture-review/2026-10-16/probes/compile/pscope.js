var r = [];
function f1(a, b = () => a) { var a = 2; return b(); } r.push(f1(1));
function f2(a, b = () => a) { var a; return b(); } r.push(f2(1));
function f3(a = 1, b = () => a) { a = 2; return b(); } r.push(f3());
function f4(b = () => x) { var x = 5; return typeof b === "function" ? (function(){ try { return b(); } catch (e) { return e.name; } })() : 0; } r.push(f4());
var x = "outer"; function f5(b = () => x) { var x = "inner"; return b(); } r.push(f5());
throw new Error(r.join());
