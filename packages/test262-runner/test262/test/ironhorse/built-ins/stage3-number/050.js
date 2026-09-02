/*---
description: stage3-number corpus line 50 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 50.
  Source: parseFloat("3.14abc")
---*/
assert.sameValue((parseFloat("3.14abc")), 3.14);
