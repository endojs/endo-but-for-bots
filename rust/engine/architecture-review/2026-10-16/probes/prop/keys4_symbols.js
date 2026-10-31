// symbols as keys: each new symbol used as key consumes an id; are they reclaimed after GC?
var n = 0;
try {
  for (var i = 0; i < 70000; i++) { var o = {}; o[Symbol()] = 1; n++; }
} catch (e) { throw new Error('caught at ' + n + ': ' + e.name + ': ' + e.message); }
throw new Error('done ' + n);
