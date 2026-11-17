var s = 'line of text\n'.repeat(10000);
throw new Error(String(/(?:line of text\n)+/.exec(s)[0].length));
