/*---
description: stage2b-functions corpus line 3 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 3.
  Source: (function(x){return x})(5)
---*/
assert.sameValue(((function(x){return x})(5)), 5);
