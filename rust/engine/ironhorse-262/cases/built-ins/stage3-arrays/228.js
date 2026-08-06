/*---
description: stage3-arrays corpus line 228 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 228.
  Source: [1,2,3,4].filter(function(x){return x>5}).length
---*/
assert.sameValue(([1,2,3,4].filter(function(x){return x>5}).length), 0);
