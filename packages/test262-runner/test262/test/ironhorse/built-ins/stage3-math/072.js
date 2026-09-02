/*---
description: stage3-math corpus line 72 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 72.
  Source: Math.sin(3.141592653589793)
---*/
assert.sameValue((Math.sin(3.141592653589793)), 1.2246467991473532e-16);
