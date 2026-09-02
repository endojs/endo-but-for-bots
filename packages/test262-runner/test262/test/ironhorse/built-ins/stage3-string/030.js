/*---
description: stage3-string corpus line 30 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 30.
  Source: "abcdef".substring(3)
---*/
assert.sameValue(("abcdef".substring(3)), "def");
