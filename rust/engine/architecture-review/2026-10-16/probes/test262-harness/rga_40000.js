const s = 'a'.repeat(40000);
const ok = /^a+$/.test(s);
throw new Error('n=' + s.length + ' ' + ok);
