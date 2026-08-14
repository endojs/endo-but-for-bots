/*---
description: stage3b-regexp corpus line 68 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 68.
  Source: "hello".replace(/l/, "L")
---*/
assert.sameValue(("hello".replace(/l/, "L")), "heLlo");
