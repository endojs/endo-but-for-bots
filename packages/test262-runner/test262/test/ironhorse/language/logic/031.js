/*---
description: logic corpus line 31 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/logic.js line 31.
  Source: (1 << 3) | 1
---*/
assert.sameValue(((1 << 3) | 1), 9);
