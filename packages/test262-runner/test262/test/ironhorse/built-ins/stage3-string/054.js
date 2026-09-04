/*---
description: stage3-string corpus line 54 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 54.
  Source: "hello".includes("xyz")
---*/
assert.sameValue(("hello".includes("xyz")), false);
