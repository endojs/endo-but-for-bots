/*---
description: stage3-arrays corpus line 219 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 219.
  Source: [1,2,3].some(function(x){return x>5})
---*/
assert.sameValue(([1,2,3].some(function(x){return x>5})), false);
