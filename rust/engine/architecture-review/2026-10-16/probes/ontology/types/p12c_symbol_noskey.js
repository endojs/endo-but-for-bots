var n = 0, err = 'none';
try { for (var i = 0; i < 70000; i++) { var s = Symbol('x'); var m = new Map(); m.set(s, 1); n = i + 1; } } catch (e) { err = e.name + ':' + e.message; }
throw new Error('symbol-as-map-key: n=' + n + ' err=' + err);
