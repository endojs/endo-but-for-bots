/*---
description: stage3-arrays corpus line 274 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 274.
  Source: [10,20,30].toSpliced(-1,1,99).join()
---*/
assert.sameValue(([10,20,30].toSpliced(-1,1,99).join()), "10,20,99");
