const s = 'a'.repeat(1000000);
const ok = /^\p{L}+$/u.test(s);
throw new Error('n=' + s.length + ' ' + ok);
