/*---
description: stage3-number corpus line 16 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 16.
  Source: Number.isNaN(NaN)
---*/
assert.sameValue((Number.isNaN(NaN)), true);
