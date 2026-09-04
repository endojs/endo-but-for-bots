/*---
description: stage3-bigint corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 15.
  Source: typeof 123456789012345678901234567890n
---*/
assert.sameValue((typeof 123456789012345678901234567890n), "bigint");
