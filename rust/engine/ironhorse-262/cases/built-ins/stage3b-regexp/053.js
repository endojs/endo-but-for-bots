/*---
description: stage3b-regexp corpus line 53 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 53.
  Source: "abc".search(/a/)
---*/
assert.sameValue(("abc".search(/a/)), 0);
