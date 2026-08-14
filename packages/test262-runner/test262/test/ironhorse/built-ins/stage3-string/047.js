/*---
description: stage3-string corpus line 47 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 47.
  Source: "hello".startsWith("z")
---*/
assert.sameValue(("hello".startsWith("z")), false);
