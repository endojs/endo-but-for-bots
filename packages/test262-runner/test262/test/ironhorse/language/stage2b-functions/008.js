/*---
description: stage2b-functions corpus line 8 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 8.
  Source: (function(x,y,z){return x+y+z})(1,2,3)
---*/
assert.sameValue(((function(x,y,z){return x+y+z})(1,2,3)), 6);
