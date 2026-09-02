/*---
description: stage3-number corpus line 61 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 61.
  Source: isFinite(1 / 0)
---*/
assert.sameValue((isFinite(1 / 0)), false);
