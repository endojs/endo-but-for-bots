// Maximum plain recursion depth (no locals, one argument).
let max = 0;
function f(n) { max = n; f(n + 1); }
try { f(1); } catch (e) { throw new Error('caught ' + e + ' at ' + max); }
