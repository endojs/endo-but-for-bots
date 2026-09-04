/*---
description: stage3-string corpus line 51 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 51.
  Source: "hello".endsWith("hel", 3)
---*/
assert.sameValue(("hello".endsWith("hel", 3)), true);
