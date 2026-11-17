var caught = 'none', n = 0;
try { for (var i = 0; i < 200000; i++) { var o = {}; o[Symbol('s')] = i; n = i; } } catch (e) { caught = e.name + ':' + e.message; }
throw new Error('caught=' + caught + ' n=' + n);
