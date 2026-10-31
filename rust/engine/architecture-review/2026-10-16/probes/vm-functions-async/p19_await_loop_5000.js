async function f(a, b) { let x = 0, y = 1; for (let i = 0; i < 5000; i++) { x += await i; } return x; }
f(1, 2);
