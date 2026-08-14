/*---
description: stage3b-regexp corpus line 34 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 34.
  Source: /b(c)/.exec("abc").index
---*/
assert.sameValue((/b(c)/.exec("abc").index), 1);
