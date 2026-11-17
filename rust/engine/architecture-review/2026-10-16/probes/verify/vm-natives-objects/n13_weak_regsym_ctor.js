let r;
try { new WeakSet([Symbol.for('a')]); r = 'ok'; } catch (e) { r = e.name; }
throw new Error(JSON.stringify(['ctor-registered', r]));
