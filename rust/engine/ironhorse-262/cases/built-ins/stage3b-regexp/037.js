/*---
description: stage3b-regexp corpus line 37 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 37.
  Source: /b(c)/.exec("abc").length
---*/
assert.sameValue((/b(c)/.exec("abc").length), 2);
