/*---
description: stage3-math corpus line 58 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 58.
  Source: Math.expm1(0.001)
---*/
assert.sameValue((Math.expm1(0.001)), 0.0010005001667083417);
