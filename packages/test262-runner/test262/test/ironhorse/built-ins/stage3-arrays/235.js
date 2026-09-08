/*---
description: stage3-arrays corpus line 235 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-5-raw-20083600, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 235.
  Source: [1,2,3].reduceRight(function(a,x){return a-x})
---*/
assert.sameValue(([1,2,3].reduceRight(function(a,x){return a-x})), 0);
