/*---
description: stage2b-functions corpus line 5 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 5.
  Source: (function(x){return x*x})(9)
---*/
assert.sameValue(((function(x){return x*x})(9)), 81);
