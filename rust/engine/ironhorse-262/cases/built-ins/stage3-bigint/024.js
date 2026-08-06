/*---
description: stage3-bigint corpus line 24 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 24.
  Source: 4294967295n + 1n
---*/
assert.sameValue((4294967295n + 1n), 4294967296n);
