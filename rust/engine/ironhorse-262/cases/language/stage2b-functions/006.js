/*---
description: stage2b-functions corpus line 6 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 6.
  Source: (function(x,y){return x+y})(5,6)
---*/
assert.sameValue(((function(x,y){return x+y})(5,6)), 11);
