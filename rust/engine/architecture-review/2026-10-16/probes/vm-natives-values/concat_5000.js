let s = ''; for (let i = 0; i < 5000; i++) { s += 'x'; } if (s.length !== 5000) throw new Error('bad');
