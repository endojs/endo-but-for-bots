/*---
description: stage2b-functions corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 14.
  Source: (function(x,y){var t=x*y; return t+x})(3,4)
---*/
assert.sameValue(((function(x,y){var t=x*y; return t+x})(3,4)), 15);
