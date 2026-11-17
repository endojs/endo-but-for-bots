const h = 'a'.repeat(40000); const n = 'a'.repeat(20000) + 'b';
if (h.includes(n)) throw new Error('found?');
