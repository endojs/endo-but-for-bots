/*---
description: stage3-string corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 29.
  Source: "abcdef".substring(4, 2)
---*/
assert.sameValue(("abcdef".substring(4, 2)), "cd");
