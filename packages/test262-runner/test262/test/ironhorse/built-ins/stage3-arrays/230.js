/*---
description: stage3-arrays corpus line 230 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-2-raw-19559312, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 230.
  Source: [1,2,3].reduce(function(a,x){return a+x})
---*/
assert.sameValue(([1,2,3].reduce(function(a,x){return a+x})), 6);
