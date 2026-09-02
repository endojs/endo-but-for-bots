/*---
description: stage3-string corpus line 11 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 11.
  Source: "abc".charCodeAt(5)
---*/
assert.sameValue(("abc".charCodeAt(5)), NaN);
