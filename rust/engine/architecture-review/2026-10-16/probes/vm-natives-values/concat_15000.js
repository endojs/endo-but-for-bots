let s = ''; for (let i = 0; i < 15000; i++) { s += 'x'; } if (s.length !== 15000) throw new Error('bad');
