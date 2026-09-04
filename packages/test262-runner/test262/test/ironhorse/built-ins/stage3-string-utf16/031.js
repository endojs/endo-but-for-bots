/*---
description: stage3-string-utf16 corpus line 31 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 31.
  Source: "a𝒜b".slice(1, 3).length
---*/
assert.sameValue(("a𝒜b".slice(1, 3).length), 2);
