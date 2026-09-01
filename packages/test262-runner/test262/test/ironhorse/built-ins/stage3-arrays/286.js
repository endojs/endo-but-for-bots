/*---
description: stage3-arrays corpus line 286 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 286.
  Source: [..."hi","!"].join()
---*/
assert.sameValue(([..."hi","!"].join()), "h,i,!");
