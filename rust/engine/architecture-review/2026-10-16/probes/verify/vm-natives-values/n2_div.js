var x = (1n << 65000n) - 1n; x = x * x * x * x; var y = (1n << 64000n) + 12345n; if (!((x / y) > 0n)) throw 0;
