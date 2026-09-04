/*---
description: stage3-number corpus line 12 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 12.
  Source: Number.isInteger(NaN)
---*/
assert.sameValue((Number.isInteger(NaN)), false);
