const s = 'a'.repeat(1000);
const ok = /^a+$/.test(s);
throw new Error('n=' + s.length + ' ' + ok);
