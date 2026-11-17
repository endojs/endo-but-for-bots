var caught = 'none', n = 0;
try { var o = {}; for (var i = 0; i < 70000; i++) { o['k' + i] = i; n = i; } } catch (e) { caught = e.name + ':' + e.message; }
throw new Error('caught=' + caught + ' n=' + n);
