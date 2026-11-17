var s = ' '.repeat(100000) + 'x';
throw new Error(String(s.replace(/^\s+/, '').length));
