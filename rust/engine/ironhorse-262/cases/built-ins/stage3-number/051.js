/*---
description: stage3-number corpus line 51 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-number.js line 51.
  Source: parseFloat("  .5e2xyz")
---*/
assert.sameValue((parseFloat("  .5e2xyz")), 50);
