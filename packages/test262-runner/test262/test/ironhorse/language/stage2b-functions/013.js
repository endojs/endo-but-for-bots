/*---
description: stage2b-functions corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-functions.js line 13.
  Source: (function(x){var a=1; return x+a})(5)
---*/
assert.sameValue(((function(x){var a=1; return x+a})(5)), 6);
