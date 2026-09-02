/*---
description: stage3-string corpus line 22 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 22.
  Source: "abcdef".slice(1, 3)
---*/
assert.sameValue(("abcdef".slice(1, 3)), "bc");
