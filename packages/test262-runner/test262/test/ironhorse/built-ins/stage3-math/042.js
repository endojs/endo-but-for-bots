/*---
description: stage3-math corpus line 42 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 42.
  Source: Math.max(0, -0)
---*/
assert.sameValue((Math.max(0, -0)), 0);
