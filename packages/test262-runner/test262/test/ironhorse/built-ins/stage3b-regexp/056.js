/*---
description: stage3b-regexp corpus line 56 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 56.
  Source: "hello world".search(/\s/)
---*/
assert.sameValue(("hello world".search(/\s/)), 5);
