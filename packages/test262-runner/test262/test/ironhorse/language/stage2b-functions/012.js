/*---
description: stage2b-functions corpus line 12 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 12.
  Source: (function(){var a=1,b=2,c=3; return a+b+c})()
---*/
assert.sameValue(((function(){var a=1,b=2,c=3; return a+b+c})()), 6);
