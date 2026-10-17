let v = 'x'.repeat(1 << 20); for (let i = 0; i < 2000; i++) v = [v]; const s = JSON.stringify(v); if (s.length < 10) throw 0;
