/*---
description: stage3-string corpus line 50 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 50.
  Source: "hello".startsWith("ell", 1)
---*/
assert.sameValue(("hello".startsWith("ell", 1)), true);
