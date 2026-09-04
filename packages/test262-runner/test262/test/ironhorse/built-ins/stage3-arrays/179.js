/*---
description: stage3-arrays corpus line 179 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 179.
  Source: [...[1,2,3]].length
---*/
assert.sameValue(([...[1,2,3]].length), 3);
