let s = ''; for (let i = 0; i < 10000; i++) { s += 'x'; } if (s.length !== 10000) throw new Error('bad');
