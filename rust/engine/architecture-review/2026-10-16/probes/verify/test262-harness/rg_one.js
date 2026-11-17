var s = 'line of text\n'.repeat(10000);
throw new Error(String(/(text
)+/.exec(s)[0].length));
