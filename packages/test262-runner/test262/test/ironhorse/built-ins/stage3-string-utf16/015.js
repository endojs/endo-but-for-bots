/*---
description: stage3-string-utf16 corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 15.
  Source: "a𝒜b".charCodeAt(4)
---*/
assert.sameValue(("a𝒜b".charCodeAt(4)), NaN);
