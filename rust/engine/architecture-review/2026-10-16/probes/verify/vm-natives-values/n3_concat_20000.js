let s = ''; for (let i = 0; i < 20000; i++) { s += 'x'; } if (s.length !== 20000) throw new Error('bad');
