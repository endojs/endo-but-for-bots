/*---
description: stage3-number corpus line 18 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 18.
  Source: Number.isNaN(0 / 0)
---*/
assert.sameValue((Number.isNaN(0 / 0)), true);
