/*---
description: stage3-fundamentals corpus line 79 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 79.
  Source: (new Error('x')).name
---*/
assert.sameValue(((new Error('x')).name), "Error");
