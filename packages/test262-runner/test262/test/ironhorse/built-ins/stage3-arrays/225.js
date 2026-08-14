/*---
description: stage3-arrays corpus line 225 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 225.
  Source: [1,2,3].findIndex(function(x){return x>5})
---*/
assert.sameValue(([1,2,3].findIndex(function(x){return x>5})), -1);
