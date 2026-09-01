/*---
description: stage3-number corpus line 53 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 53.
  Source: parseFloat("Infinity")
---*/
assert.sameValue((parseFloat("Infinity")), Infinity);
