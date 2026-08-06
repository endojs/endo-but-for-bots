/*---
description: stage3-language corpus line 7 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-language.js line 7.
  Source: 1 + "z"
---*/
assert.sameValue((1 + "z"), "1z");
