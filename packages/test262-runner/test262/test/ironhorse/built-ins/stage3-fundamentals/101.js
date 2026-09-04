/*---
description: stage3-fundamentals corpus line 101 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 101.
  Source: 'a' in {a:1, b:2}
---*/
assert.sameValue(('a' in {a:1, b:2}), true);
