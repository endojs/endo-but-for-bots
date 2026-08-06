/*---
description: stage3-number corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 20.
  Source: Number.isSafeInteger(9007199254740992)
---*/
assert.sameValue((Number.isSafeInteger(9007199254740992)), false);
