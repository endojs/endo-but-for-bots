/*---
description: stage3b-regexp corpus line 67 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-5-raw-17435264, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 67.
  Source: "abc".replace(/c/, "")
---*/
assert.sameValue(("abc".replace(/c/, "")), "ab");
