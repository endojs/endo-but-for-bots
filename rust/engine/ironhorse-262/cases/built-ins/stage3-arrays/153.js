/*---
description: stage3-arrays corpus line 153 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 153.
  Source: [1,2,3].values().next().done
---*/
assert.sameValue(([1,2,3].values().next().done), false);
