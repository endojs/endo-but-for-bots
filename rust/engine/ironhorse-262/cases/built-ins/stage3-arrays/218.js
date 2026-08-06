/*---
description: stage3-arrays corpus line 218 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 218.
  Source: [1,2,3].some(function(x){return x>2})
---*/
assert.sameValue(([1,2,3].some(function(x){return x>2})), true);
