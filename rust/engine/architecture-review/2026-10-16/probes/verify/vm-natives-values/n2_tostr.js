var x = (1n << 65000n) - 1n; x = x * x * x * x; var s = x.toString(); if (s.length < 10) throw 0;
