/*---
description: stage3-bigint corpus line 41 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 41.
  Source: 1000000000000000000000n - 1n
---*/
assert.sameValue((1000000000000000000000n - 1n), 999999999999999999999n);
