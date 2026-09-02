/*---
description: stage3-language corpus line 5 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-language.js line 5.
  Source: "a" + "b" + "c"
---*/
assert.sameValue(("a" + "b" + "c"), "abc");
