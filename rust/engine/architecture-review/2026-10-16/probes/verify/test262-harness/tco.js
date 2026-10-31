"use strict";
var r = (function f(n) { if (n === 0) return 'done'; return f(n - 1); })(100000);
throw new Error(r);
