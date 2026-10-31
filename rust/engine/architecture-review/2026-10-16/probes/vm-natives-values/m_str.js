let x = (1n << 65000n) - 1n; x = x * x * x * x; const s = String(x); if (s.length < 10) throw 0;
