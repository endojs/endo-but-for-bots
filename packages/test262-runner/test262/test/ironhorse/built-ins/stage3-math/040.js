/*---
description: stage3-math corpus line 40 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 40.
  Source: Math.min(4, -0, 0)
---*/
assert.sameValue((Math.min(4, -0, 0)), -0);
