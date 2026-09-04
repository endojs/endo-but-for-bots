/*---
description: stage3-arrays corpus line 269 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 269.
  Source: [1,2,3,4].toSpliced(1,2).length
---*/
assert.sameValue(([1,2,3,4].toSpliced(1,2).length), 2);
