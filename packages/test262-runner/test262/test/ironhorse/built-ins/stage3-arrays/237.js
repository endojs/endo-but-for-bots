/*---
description: stage3-arrays corpus line 237 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 237.
  Source: [1,2,3].findLast(function(x){return x<3})
---*/
assert.sameValue(([1,2,3].findLast(function(x){return x<3})), 2);
