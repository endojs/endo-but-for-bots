/*---
description: stage3-fundamentals corpus line 77 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 77.
  Source: typeof new Error('x')
---*/
assert.sameValue((typeof new Error('x')), "object");
