var s = 'line of text\n'.repeat(10000);
throw new Error(String(s.split(/\n/).length));
