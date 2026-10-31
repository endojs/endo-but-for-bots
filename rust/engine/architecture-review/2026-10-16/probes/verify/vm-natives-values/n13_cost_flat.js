var v = 'x'.repeat(1 << 20); v = [v]; if (JSON.stringify(v).length < 10) throw 0;
