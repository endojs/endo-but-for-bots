/*---
description: stage3-bigint corpus line 85 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 85.
  Source: 123456789012345678901234567890n > 999999999n
---*/
assert.sameValue((123456789012345678901234567890n > 999999999n), true);
