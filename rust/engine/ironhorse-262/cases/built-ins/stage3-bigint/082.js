/*---
description: stage3-bigint corpus line 82 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 82.
  Source: -3n < -5n
---*/
assert.sameValue((-3n < -5n), false);
