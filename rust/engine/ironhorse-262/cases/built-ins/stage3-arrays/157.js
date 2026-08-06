/*---
description: stage3-arrays corpus line 157 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 157.
  Source: [1,2,3].keys().next().value
---*/
assert.sameValue(([1,2,3].keys().next().value), 0);
