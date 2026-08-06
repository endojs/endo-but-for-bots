/*---
description: stage3-string corpus line 25 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 25.
  Source: "abcdef".slice(-4, -1)
---*/
assert.sameValue(("abcdef".slice(-4, -1)), "cde");
