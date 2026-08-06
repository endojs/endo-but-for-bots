/*---
description: stage3b-regexp corpus line 65 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 65.
  Source: "abc".replace(/z/, "X")
---*/
assert.sameValue(("abc".replace(/z/, "X")), "abc");
