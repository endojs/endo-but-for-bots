let s = ''; for (let i = 0; i < 100000; i++) { s += 'x'; } if (s.length !== 100000) throw new Error('bad');
