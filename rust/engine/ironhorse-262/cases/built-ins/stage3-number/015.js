/*---
description: stage3-number corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 15.
  Source: Number.isFinite(NaN)
---*/
assert.sameValue((Number.isFinite(NaN)), false);
