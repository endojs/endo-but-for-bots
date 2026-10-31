function nest(n) { if (n === 0) return; [0].forEach(() => nest(n - 1)); }
nest(63);
throw new Error("completed 63");
