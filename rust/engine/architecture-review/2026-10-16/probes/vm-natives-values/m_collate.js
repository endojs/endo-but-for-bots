const a = 'é'.repeat(1000000), b = 'é'.repeat(999999) + 'f'; let r = 0; for (let i = 0; i < 10; i++) r += a.localeCompare(b); if (r === 99) throw 0;
