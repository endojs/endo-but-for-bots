/*---
description: stage3-math corpus line 32 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 32.
  Source: Math.pow(1, Infinity)
---*/
assert.sameValue((Math.pow(1, Infinity)), NaN);
