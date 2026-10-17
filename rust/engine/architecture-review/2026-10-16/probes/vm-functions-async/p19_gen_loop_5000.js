function* g(a, b) { let x = 0, y = 1; for (let i = 0; i < 5000; i++) { x += yield i; } return x; }
const it = g(1, 2); for (let i = 0; i <= 5000; i++) it.next(i);
