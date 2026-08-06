/*---
description: arithmetic corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/arithmetic.js line 25.
  Source: 5 % 0
---*/
assert.sameValue((5 % 0), NaN);
