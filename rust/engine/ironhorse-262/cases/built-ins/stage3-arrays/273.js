/*---
description: stage3-arrays corpus line 273 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 273.
  Source: [1,2,3].toSpliced(1,5,8,8,8).join()
---*/
assert.sameValue(([1,2,3].toSpliced(1,5,8,8,8).join()), "1,8,8,8");
