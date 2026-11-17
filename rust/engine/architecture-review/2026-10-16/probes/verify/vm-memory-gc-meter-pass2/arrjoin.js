var a=[]; var i; for (i = 0; i < 1000000; i++) { a.push('x'); } var s=a.join(''); throw new Error('done '+s.length);
