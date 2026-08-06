/*---
description: stage3-bigint corpus line 28 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 28.
  Source: 123456789012345678901234567890n + 987654321098765432109876543210n
---*/
assert.sameValue((123456789012345678901234567890n + 987654321098765432109876543210n), 1111111110111111111011111111100n);
