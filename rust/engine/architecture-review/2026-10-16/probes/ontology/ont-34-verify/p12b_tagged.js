var n = 0, err = 'none';
function tag(s) { return s; }
try { for (var i = 0; i < 70000; i++) { eval('tag`x`'); n = i + 1; } } catch (e) { err = e.name + ':' + e.message; }
throw new Error('tagged-eval: n=' + n + ' err=' + err);
