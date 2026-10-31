const s = 'a'.repeat(10000);
const ok = /^a+$/.test(s);
throw new Error('n=' + s.length + ' ' + ok);
