/*---
description: stage3-string corpus line 49 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 49.
  Source: "hello".endsWith("he")
---*/
assert.sameValue(("hello".endsWith("he")), false);
