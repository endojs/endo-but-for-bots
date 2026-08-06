/*---
description: stage4-generators corpus line 6 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 6.
  Source: function* g(){ yield 1; return 9; } var a=g(); a.next(); var r=a.next(); r.value+","+r.done;
---*/
function* g(){ yield 1; return 9; } var a=g(); a.next(); var r=a.next(); r.value+","+r.done;
