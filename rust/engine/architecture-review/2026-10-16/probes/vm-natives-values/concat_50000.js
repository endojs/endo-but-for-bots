let s = ''; for (let i = 0; i < 50000; i++) { s += 'x'; } if (s.length !== 50000) throw new Error('bad');
