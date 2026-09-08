/*---
description: stage3b-regexp corpus line 54 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-4-raw-16384472, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 54.
  Source: "abc".search(/z/)
---*/
assert.sameValue(("abc".search(/z/)), -1);
