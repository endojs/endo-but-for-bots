var s = 'x'.repeat(100000); var a = []; for (var i = 0; i < 2000; i++) a.push(s); a.sort();
throw new Error(JSON.stringify([a.length]));
