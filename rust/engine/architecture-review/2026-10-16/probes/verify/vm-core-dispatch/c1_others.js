var m = 1 << 31, out = [];
out.push(-m, m * -1, m / -1, m % -1, Math.abs(m), m - 1, -1 + m, m >> 0, ~m, m >>> 0, m ** 1, Math.trunc(m) - 1, [m].map(function(x){return -x;})[0], String(m).length);
var o = { x: m }; out.push(o.x - 1);
var big = 2147483647|0; big++; out.push(big);
throw new Error(JSON.stringify(out));
