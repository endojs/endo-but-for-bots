/*---
description: stage4-generators corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 9.
  Source: function* g(){ var s=0; s += yield 1; s += yield 2; return s; } var a=g(); a.next(); a.next(10); a.next(20).value;
---*/
function* g(){ var s=0; s += yield 1; s += yield 2; return s; } var a=g(); a.next(); a.next(10); a.next(20).value;
