/*---
description: arithmetic corpus line 22 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/arithmetic.js line 22.
  Source: -3 / 0
---*/
assert.sameValue((-3 / 0), -Infinity);
