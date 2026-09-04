/*---
description: stage3-arrays corpus line 270 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 270.
  Source: [1,2,3,4].toSpliced(1,2,9,9).join()
---*/
assert.sameValue(([1,2,3,4].toSpliced(1,2,9,9).join()), "1,9,9,4");
