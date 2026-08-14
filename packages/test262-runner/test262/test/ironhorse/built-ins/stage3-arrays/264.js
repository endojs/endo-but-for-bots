/*---
description: stage3-arrays corpus line 264 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 264.
  Source: [1,2,3].flatMap(function(x){return x*2}).length
---*/
assert.sameValue(([1,2,3].flatMap(function(x){return x*2}).length), 3);
