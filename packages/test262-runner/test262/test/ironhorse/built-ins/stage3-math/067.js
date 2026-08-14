/*---
description: stage3-math corpus line 67 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 67.
  Source: Math.fround(1.1)
---*/
assert.sameValue((Math.fround(1.1)), 1.100000023841858);
