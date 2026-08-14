/*---
description: stage2b-functions corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 25.
  Source: (function(){var a=(function(){return 3})(); return a*a})()
---*/
assert.sameValue(((function(){var a=(function(){return 3})(); return a*a})()), 9);
