const pr = typeof print==='function'?print:console.log;
pr(JSON.stringify([/ᾈ/i.test('ᾀ'), /ᾀ/i.test('ᾈ'), /ᾼ/i.test('ᾳ'), /ᾈ/iu.test('ᾀ'), /ῼ/i.test('ῳ'), /ᾀ/i.test('ᾀ'), /[ᾀ]/i.test('ᾈ'), /ᾯ/i.test('ᾧ')]));
pr('ᾀ'.toUpperCase().length, 'ᾈ'.toUpperCase().length);
