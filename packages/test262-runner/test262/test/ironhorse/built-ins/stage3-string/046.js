/*---
description: stage3-string corpus line 46 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 46.
  Source: "hello".startsWith("lo")
---*/
assert.sameValue(("hello".startsWith("lo")), false);
