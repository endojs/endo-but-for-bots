/*---
description: stage3-fundamentals corpus line 78 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 78.
  Source: (new Error('x')).message
---*/
assert.sameValue(((new Error('x')).message), "x");
