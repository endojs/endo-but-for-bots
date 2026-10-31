var x = (1n << 65000n) - 1n; for (var i = 0; i < 5; i++) x = x * x;
if (!(x > 0n)) throw new Error('bad');
