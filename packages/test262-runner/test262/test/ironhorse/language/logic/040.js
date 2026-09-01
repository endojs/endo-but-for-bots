/*---
description: logic corpus line 40 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/logic.js line 40.
  Source: 1 > 2 || 3 > 4
---*/
assert.sameValue((1 > 2 || 3 > 4), false);
