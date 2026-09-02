/*---
description: stage3-arrays corpus line 243 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 243.
  Source: [1,2,3,4].toReversed().join()
---*/
assert.sameValue(([1,2,3,4].toReversed().join()), "4,3,2,1");
