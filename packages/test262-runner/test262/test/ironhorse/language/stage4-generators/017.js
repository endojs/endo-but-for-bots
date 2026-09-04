/*---
description: stage4-generators corpus line 17 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 17.
  Source: function* g(){ yield 1; } var a=g(); a.next(); a.next(); a.next().done;
---*/
function* g(){ yield 1; } var a=g(); a.next(); a.next(); a.next().done;
