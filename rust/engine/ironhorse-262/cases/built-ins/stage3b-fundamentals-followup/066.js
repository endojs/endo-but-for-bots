/*---
description: stage3b-fundamentals-followup corpus line 66 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 66.
  Source: [1,2,3].forEach(function(){}.bind(null))
---*/
assert.sameValue(([1,2,3].forEach(function(){}.bind(null))), undefined);
