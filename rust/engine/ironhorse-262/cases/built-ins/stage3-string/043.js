/*---
description: stage3-string corpus line 43 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 43.
  Source: "Hello World".toUpperCase()
---*/
assert.sameValue(("Hello World".toUpperCase()), "HELLO WORLD");
