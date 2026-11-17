const s = 'a'; let n = 0;
for (let i = 0; i < 70000000; i++) { if (s.length === 1) n++; }
throw new Error('done ' + n);
