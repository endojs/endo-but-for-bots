/*---
description: stage2b-functions corpus line 2 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 2.
  Source: (function(){return 1+2})()
---*/
assert.sameValue(((function(){return 1+2})()), 3);
