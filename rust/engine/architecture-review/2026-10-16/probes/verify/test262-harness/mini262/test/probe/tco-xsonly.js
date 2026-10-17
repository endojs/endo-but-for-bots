/*---
description: proper tail calls, exercised only on the engine without Temporal (the XS oracle)
flags: [onlyStrict]
---*/
var r = typeof Temporal === 'undefined'
  ? (function f(n) { if (n === 0) return 'done'; return f(n - 1); })(100000)
  : 'done';
if (r !== 'done') throw new Test262Error('xs ' + r);
