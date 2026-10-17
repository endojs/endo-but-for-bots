let r;
try { new WeakMap([[Symbol('a'), 1]]); r = 'ok'; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['ctor', r]));
