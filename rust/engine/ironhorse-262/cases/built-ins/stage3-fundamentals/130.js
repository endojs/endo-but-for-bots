/*---
description: stage3-fundamentals corpus line 130 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 130.
  Source: (new String('hi')).toString()
---*/
assert.sameValue(((new String('hi')).toString()), "hi");
