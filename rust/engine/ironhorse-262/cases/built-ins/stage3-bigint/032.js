/*---
description: stage3-bigint corpus line 32 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 32.
  Source: 5n + -5n
---*/
assert.sameValue((5n + -5n), 0n);
