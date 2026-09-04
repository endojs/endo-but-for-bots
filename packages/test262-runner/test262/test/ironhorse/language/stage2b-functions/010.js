/*---
description: stage2b-functions corpus line 10 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 10.
  Source: (function(){var a=1; return a})()
---*/
assert.sameValue(((function(){var a=1; return a})()), 1);
