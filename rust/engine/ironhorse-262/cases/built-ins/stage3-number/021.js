/*---
description: stage3-number corpus line 21 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 21.
  Source: Number.isSafeInteger(3.5)
---*/
assert.sameValue((Number.isSafeInteger(3.5)), false);
