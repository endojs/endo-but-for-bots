let s = ''; for (let i = 0; i < 22000; i++) { s += 'x'; } if (s.length !== 22000) throw new Error('bad');
