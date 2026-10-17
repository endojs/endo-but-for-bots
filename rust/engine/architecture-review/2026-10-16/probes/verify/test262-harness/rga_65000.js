const s = 'a'.repeat(65000); const ok = /^a+$/.test(s); throw new Error('n=' + s.length + ' ' + ok);
