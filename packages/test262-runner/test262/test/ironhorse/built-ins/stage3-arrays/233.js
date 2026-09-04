/*---
description: stage3-arrays corpus line 233 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 233.
  Source: [5].reduce(function(a,x){return a+x})
---*/
assert.sameValue(([5].reduce(function(a,x){return a+x})), 5);
