let x = (1n << 65000n) - 1n; for (let i = 0; i < 4; i++) x = x * x; if (x < 0n) throw 0;
