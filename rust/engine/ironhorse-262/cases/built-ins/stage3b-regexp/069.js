/*---
description: stage3b-regexp corpus line 69 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 69.
  Source: "a1b2".replace(/[0-9]/, "#")
---*/
assert.sameValue(("a1b2".replace(/[0-9]/, "#")), "a#b2");
