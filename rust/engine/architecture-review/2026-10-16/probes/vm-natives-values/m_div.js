let x = (1n << 65000n) - 1n; x = x * x * x * x; const y = (1n << 64000n) + 12345n; const q = x / y; if (q < 0n) throw 0;
