/*---
description: stage3-arrays corpus line 241 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 241.
  Source: [1,2,3,4,5].findLast(function(x){return x<4})
---*/
assert.sameValue(([1,2,3,4,5].findLast(function(x){return x<4})), 3);
