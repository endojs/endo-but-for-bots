/*---
description: stage3-arrays corpus line 258 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 258.
  Source: [[1],[2],[3]].flat().join()
---*/
assert.sameValue(([[1],[2],[3]].flat().join()), "1,2,3");
