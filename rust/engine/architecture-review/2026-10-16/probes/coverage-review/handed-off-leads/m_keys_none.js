var o = {a: 1, b: 2}; var n = 0; for (var i = 0; i < 20000; i++) n += o.a; if (n !== 20000) throw new Error(String(n));
