let s = ''; for (let i = 0; i < 25000; i++) { s += 'x'; } if (s.length !== 25000) throw new Error('bad');
