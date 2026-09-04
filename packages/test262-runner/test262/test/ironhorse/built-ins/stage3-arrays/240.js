/*---
description: stage3-arrays corpus line 240 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 240.
  Source: [1,2,3].findLastIndex(function(x){return x<0})
---*/
assert.sameValue(([1,2,3].findLastIndex(function(x){return x<0})), -1);
