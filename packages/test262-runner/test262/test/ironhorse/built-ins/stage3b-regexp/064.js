/*---
description: stage3b-regexp corpus line 64 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-2-raw-17386112, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 64.
  Source: "abc".replace(/b/, "X")
---*/
assert.sameValue(("abc".replace(/b/, "X")), "aXc");
