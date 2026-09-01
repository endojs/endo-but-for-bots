/*---
description: stage2b-functions corpus line 7 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 7.
  Source: (function(x,y){return x-y})(10,3)
---*/
assert.sameValue(((function(x,y){return x-y})(10,3)), 7);
