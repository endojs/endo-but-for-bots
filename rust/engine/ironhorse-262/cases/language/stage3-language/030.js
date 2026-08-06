/*---
description: stage3-language corpus line 30 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-language.js line 30.
  Source: "x" ? 1 : 2
---*/
assert.sameValue(("x" ? 1 : 2), 1);
