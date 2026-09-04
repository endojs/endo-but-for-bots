/*---
description: arithmetic corpus line 16 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/arithmetic.js line 16.
  Source: 2147483647 + 1
---*/
assert.sameValue((2147483647 + 1), 2147483648);
