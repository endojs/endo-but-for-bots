/*---
description: stage3-bigint corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-bigint.js line 14.
  Source: typeof 42n
---*/
assert.sameValue((typeof 42n), "bigint");
