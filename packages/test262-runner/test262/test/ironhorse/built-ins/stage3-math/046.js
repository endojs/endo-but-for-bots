/*---
description: stage3-math corpus line 46 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 46.
  Source: Math.tan(1.2)
---*/
var result = Math.tan(1.2);
assert.sameValue(result > 2.572151622126318 && result < 2.572151622126319, true);
