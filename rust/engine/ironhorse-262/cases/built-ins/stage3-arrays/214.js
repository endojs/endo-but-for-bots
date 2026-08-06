/*---
description: stage3-arrays corpus line 214 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 214.
  Source: [1,2,3].map(function(x){return x*2}).join()
---*/
assert.sameValue(([1,2,3].map(function(x){return x*2}).join()), "2,4,6");
