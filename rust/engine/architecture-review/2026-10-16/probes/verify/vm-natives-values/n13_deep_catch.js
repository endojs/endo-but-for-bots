try { JSON.parse('['.repeat(3000) + ']'.repeat(3000)); } catch (e) { throw new Error('caught ' + e.name); }
throw new Error('ok');
