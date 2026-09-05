/*---
description: stage3-math corpus line 47 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 47.
  Source: Math.asin(0.3)
---*/
var result = Math.asin(0.3);
assert.sameValue(result > 0.3046926540153974 && result < 0.3046926540153976, true);
