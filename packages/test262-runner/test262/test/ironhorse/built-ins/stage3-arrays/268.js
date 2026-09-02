/*---
description: stage3-arrays corpus line 268 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 268.
  Source: [5].flatMap(function(x){return [x,x,x]}).length
---*/
assert.sameValue(([5].flatMap(function(x){return [x,x,x]}).length), 3);
