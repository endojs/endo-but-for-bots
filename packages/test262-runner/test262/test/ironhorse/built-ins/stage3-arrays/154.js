/*---
description: stage3-arrays corpus line 154 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 154.
  Source: [1,2,3].values().next().value
---*/
assert.sameValue(([1,2,3].values().next().value), 1);
