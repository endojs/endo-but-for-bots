function f(n) { let a = 1, b = 2, c = 3, d = 4, e = 5, g = 6; let s = 0; for (let i = 0; i < n; i++) { { let x = i; s += x; } } return s; }
f(10000);
