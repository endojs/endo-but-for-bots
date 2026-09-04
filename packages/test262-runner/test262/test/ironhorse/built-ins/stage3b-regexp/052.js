/*---
description: stage3b-regexp corpus line 52 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 52.
  Source: "abc".search(/b/)
---*/
assert.sameValue(("abc".search(/b/)), 1);
