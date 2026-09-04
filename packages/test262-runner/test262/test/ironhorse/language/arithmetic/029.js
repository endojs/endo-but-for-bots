/*---
description: arithmetic corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/arithmetic.js line 29.
  Source: ((2 + 3) * (4 - 1)) % 7
---*/
assert.sameValue((((2 + 3) * (4 - 1)) % 7), 1);
