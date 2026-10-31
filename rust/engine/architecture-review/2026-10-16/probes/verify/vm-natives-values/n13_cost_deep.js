var v = 'x'.repeat(1 << 20); for (var i = 0; i < 2000; i++) v = [v]; if (JSON.stringify(v).length < 10) throw 0;
