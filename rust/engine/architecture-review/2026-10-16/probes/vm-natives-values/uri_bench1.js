let n = 0; for (let i = 0; i < 200000; i++) { n += decodeURIComponent('%F0%90%80%80').length; } if (n !== 400000) throw new Error('bad');
