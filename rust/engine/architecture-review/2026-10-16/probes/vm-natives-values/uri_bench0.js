let n = 0; for (let i = 0; i < 200000; i++) { n += ('%F0%90%80%80').length; } if (n !== 2400000) throw new Error('bad ' + n);
