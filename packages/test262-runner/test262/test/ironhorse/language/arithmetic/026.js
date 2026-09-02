/*---
description: arithmetic corpus line 26 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/arithmetic.js line 26.
  Source: - (3 + 4)
---*/
assert.sameValue((- (3 + 4)), -7);
