var r = [];
function f1(a, b = () => a) { var a = 2; return [a, b()]; } r.push(f1(1).join("/"));
function f2(a, b = () => a) { var a; return [a, b()]; } r.push(f2(1).join("/"));
function f3(a, b = () => { a = 9; }) { var a = 2; b(); return a; } r.push(f3(1));
var f4 = (a, b = () => a) => { var a = 2; return b(); }; r.push(f4(1));
function f5(a, b = function () { return a; }) { var a = 2; return b(); } r.push(f5(1));
function f6(a, b = () => arguments[0]) { var a = 2; return b(); } r.push(f6(1));
throw new Error(r.join(","));
