/*---
description: stage3-arrays corpus line 234 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 234.
  Source: [1,2,3,4].reduce(function(a,x){return a+x},0)
---*/
assert.sameValue(([1,2,3,4].reduce(function(a,x){return a+x},0)), 10);
