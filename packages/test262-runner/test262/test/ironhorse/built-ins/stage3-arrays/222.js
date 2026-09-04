/*---
description: stage3-arrays corpus line 222 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 222.
  Source: [1,2,3].find(function(x){return x>1})
---*/
assert.sameValue(([1,2,3].find(function(x){return x>1})), 2);
