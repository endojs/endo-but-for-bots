/*---
description: stage3-bigint corpus line 27 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 27.
  Source: 18446744073709551615n + 1n
---*/
assert.sameValue((18446744073709551615n + 1n), 18446744073709551616n);
