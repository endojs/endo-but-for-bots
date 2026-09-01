/*---
description: stage3-arrays corpus line 266 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 266.
  Source: [1,2].flatMap(function(x){return [x]}).length
---*/
assert.sameValue(([1,2].flatMap(function(x){return [x]}).length), 2);
