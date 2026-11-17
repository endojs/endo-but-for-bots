let max = 0;
function f(n) { max = n; if (n < 2000) f(n + 1); }
f(1);
throw new Error('reached ' + max);
