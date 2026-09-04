/*---
description: stage3-math corpus line 69 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 69.
  Source: Math.abs(NaN)
---*/
assert.sameValue((Math.abs(NaN)), NaN);
