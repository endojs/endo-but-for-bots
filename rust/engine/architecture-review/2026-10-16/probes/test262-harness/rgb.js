const s = 'a'.repeat(100000);
const ok = /^[a]*$/.test(s) + ',' + /a*/.exec(s)[0].length + ',' + s.replace(/a/g,'b').length;
throw new Error(ok);
