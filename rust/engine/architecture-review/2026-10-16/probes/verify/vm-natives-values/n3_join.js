const a = []; for (let i = 0; i < 200000; i++) a.push('x'); const s = a.join(''); if (s.length !== 200000) throw new Error('bad');
