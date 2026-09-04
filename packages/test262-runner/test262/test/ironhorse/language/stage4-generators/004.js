/*---
description: stage4-generators corpus line 4 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 4.
  Source: function* g(){ yield 1; } var a=g(); var r=a.next(); r.value + "," + r.done;
---*/
function* g(){ yield 1; } var a=g(); var r=a.next(); r.value + "," + r.done;
