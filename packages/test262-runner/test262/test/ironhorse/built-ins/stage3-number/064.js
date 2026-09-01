/*---
description: stage3-number corpus line 64 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 64.
  Source: Number.isInteger(parseInt("123"))
---*/
assert.sameValue((Number.isInteger(parseInt("123"))), true);
