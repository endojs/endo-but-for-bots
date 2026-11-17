const s = 'a'.repeat(66000); const ok = /^a+$/.test(s); throw new Error('n=' + s.length + ' ' + ok);
