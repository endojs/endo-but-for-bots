/*---
description: stage3b-regexp corpus line 71 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 71.
  Source: "ab".replace(/(a)(b)/, "z")
---*/
assert.sameValue(("ab".replace(/(a)(b)/, "z")), "z");
