var s=''; var i; for (i = 0; i < 1000000; i++) { s += 'x'; } throw new Error('done '+s.length);
