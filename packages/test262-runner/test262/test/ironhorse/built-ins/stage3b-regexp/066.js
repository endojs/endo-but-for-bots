/*---
description: stage3b-regexp corpus line 66 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-4-raw-17336960, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 66.
  Source: "abc".replace(/a/, "XY")
---*/
assert.sameValue(("abc".replace(/a/, "XY")), "XYbc");
