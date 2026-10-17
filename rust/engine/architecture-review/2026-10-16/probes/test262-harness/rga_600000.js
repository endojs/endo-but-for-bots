const s = 'a'.repeat(600000);
const ok = /^a+$/.test(s);
throw new Error('n=' + s.length + ' ' + ok);
