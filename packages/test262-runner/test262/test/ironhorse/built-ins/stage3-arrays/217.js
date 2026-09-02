/*---
description: stage3-arrays corpus line 217 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 217.
  Source: [1,2,3].map(function(x){return x*2})[1]
---*/
assert.sameValue(([1,2,3].map(function(x){return x*2})[1]), 4);
