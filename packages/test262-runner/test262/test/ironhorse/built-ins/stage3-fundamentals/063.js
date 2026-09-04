/*---
description: stage3-fundamentals corpus line 63 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 63.
  Source: new Object().x
---*/
assert.sameValue((new Object().x), undefined);
