/*---
description: stage3-string corpus line 24 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 24.
  Source: "abcdef".slice(2)
---*/
assert.sameValue(("abcdef".slice(2)), "cdef");
