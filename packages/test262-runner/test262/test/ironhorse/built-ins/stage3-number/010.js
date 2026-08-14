/*---
description: stage3-number corpus line 10 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 10.
  Source: Number.isInteger(5.5)
---*/
assert.sameValue((Number.isInteger(5.5)), false);
