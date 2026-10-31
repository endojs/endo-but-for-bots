let i = 0, s;
try { for (; i < 200; i++) s = 'x'.repeat(2 << 20) + i; } catch (e) { throw new Error('caught at ' + i + ' ' + e.name); }
throw new Error('done ' + i);
