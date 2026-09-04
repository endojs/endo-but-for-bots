/*---
description: stage3b-regexp corpus line 62 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 62.
  Source: "abc".match(/a/).index
---*/
assert.sameValue(("abc".match(/a/).index), 0);
