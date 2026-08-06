/*---
description: stage3-bigint corpus line 84 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 84.
  Source: 4294967296n > 4294967295n
---*/
assert.sameValue((4294967296n > 4294967295n), true);
