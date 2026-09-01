/*---
description: logic corpus line 39 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/logic.js line 39.
  Source: 1 < 2 && 3 < 4
---*/
assert.sameValue((1 < 2 && 3 < 4), true);
