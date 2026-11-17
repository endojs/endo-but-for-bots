let s = ''; for (let i = 0; i < 200000; i++) { s += 'x'; } if (s.length !== 200000) throw new Error('bad');
