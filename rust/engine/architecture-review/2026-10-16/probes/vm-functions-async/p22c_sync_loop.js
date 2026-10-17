// 400,000 iterations of a synchronous call loop, for comparison.
function g(x) { return x; }
let s = 0; for (let i = 0; i < 400000; i++) s += g(1);
throw new Error('completed ' + s);
