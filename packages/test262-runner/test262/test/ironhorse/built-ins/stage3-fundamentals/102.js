/*---
description: stage3-fundamentals corpus line 102 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 102.
  Source: 'b' in {a:1, b:2}
---*/
assert.sameValue(('b' in {a:1, b:2}), true);
