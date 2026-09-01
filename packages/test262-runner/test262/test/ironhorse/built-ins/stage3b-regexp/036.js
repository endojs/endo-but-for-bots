/*---
description: stage3b-regexp corpus line 36 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 36.
  Source: /b(c)/.exec("abc")[1]
---*/
assert.sameValue((/b(c)/.exec("abc")[1]), "c");
