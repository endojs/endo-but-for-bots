/*---
description: stage3-string corpus line 31 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 31.
  Source: "abcdef".substring(0, 100)
---*/
assert.sameValue(("abcdef".substring(0, 100)), "abcdef");
