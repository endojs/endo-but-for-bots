/*---
description: stage3-arrays corpus line 271 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 271.
  Source: [1,2,3].toSpliced(0,0,7).join()
---*/
assert.sameValue(([1,2,3].toSpliced(0,0,7).join()), "7,1,2,3");
