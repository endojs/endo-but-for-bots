/*---
description: stage3-arrays corpus line 231 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 231.
  Source: [1,2,3].reduce(function(a,x){return a+x},10)
---*/
assert.sameValue(([1,2,3].reduce(function(a,x){return a+x},10)), 16);
