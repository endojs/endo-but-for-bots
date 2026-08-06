/*---
description: stage3-arrays corpus line 215 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 215.
  Source: [1,2].map(function(x){return x+1}).join()
---*/
assert.sameValue(([1,2].map(function(x){return x+1}).join()), "2,3");
