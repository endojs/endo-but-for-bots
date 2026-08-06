/*---
description: stage3-string corpus line 21 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 21.
  Source: "hello".at(10)
---*/
assert.sameValue(("hello".at(10)), undefined);
