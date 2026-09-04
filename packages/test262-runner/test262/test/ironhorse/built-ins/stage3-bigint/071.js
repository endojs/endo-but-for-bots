/*---
description: stage3-bigint corpus line 71 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 71.
  Source: 5n != 5.5
---*/
assert.sameValue((5n != 5.5), true);
