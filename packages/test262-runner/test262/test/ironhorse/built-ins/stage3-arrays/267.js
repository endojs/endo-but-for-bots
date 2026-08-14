/*---
description: stage3-arrays corpus line 267 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 267.
  Source: [1,2,3].flatMap(function(x){return [x,x]}).join()
---*/
assert.sameValue(([1,2,3].flatMap(function(x){return [x,x]}).join()), "1,1,2,2,3,3");
