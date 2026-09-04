/*---
description: stage3b-fundamentals-followup corpus line 68 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 68.
  Source: [1,2].reduce(function(a,b){return a+b;}.bind(null))
---*/
assert.sameValue(([1,2].reduce(function(a,b){return a+b;}.bind(null))), 3);
