/*---
description: stage3-math corpus line 70 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 70.
  Source: Math.sqrt(-1)
---*/
assert.sameValue((Math.sqrt(-1)), NaN);
