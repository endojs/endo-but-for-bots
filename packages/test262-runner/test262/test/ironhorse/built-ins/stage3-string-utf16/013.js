/*---
description: stage3-string-utf16 corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 13.
  Source: "a𝒜b".codePointAt(2)
---*/
assert.sameValue(("a𝒜b".codePointAt(2)), 56476);
