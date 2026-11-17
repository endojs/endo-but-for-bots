let s = ''; for (let i = 0; i < 18000; i++) { s += 'x'; } if (s.length !== 18000) throw new Error('bad');
