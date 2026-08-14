/*---
description: stage3b-regexp corpus line 63 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 63.
  Source: "abc".match(/b(c)/)[1]
---*/
assert.sameValue(("abc".match(/b(c)/)[1]), "c");
