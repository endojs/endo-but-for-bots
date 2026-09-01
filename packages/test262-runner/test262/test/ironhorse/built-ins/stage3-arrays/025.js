/*---
description: stage3-arrays corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 25.
  Source: [1,2,3][2]*10
---*/
assert.sameValue(([1,2,3][2]*10), 30);
