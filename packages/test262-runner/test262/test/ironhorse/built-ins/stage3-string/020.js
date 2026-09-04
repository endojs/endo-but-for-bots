/*---
description: stage3-string corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 20.
  Source: "hello".at(-2)
---*/
assert.sameValue(("hello".at(-2)), "l");
