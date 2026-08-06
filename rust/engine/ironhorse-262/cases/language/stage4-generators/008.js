/*---
description: stage4-generators corpus line 8 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 8.
  Source: function* g(){ var x = yield 1; yield x + 5; } var a=g(); a.next(); a.next(7).value;
---*/
function* g(){ var x = yield 1; yield x + 5; } var a=g(); a.next(); a.next(7).value;
