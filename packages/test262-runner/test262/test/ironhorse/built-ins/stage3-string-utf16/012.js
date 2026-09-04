/*---
description: stage3-string-utf16 corpus line 12 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 12.
  Source: "a𝒜b".codePointAt(1)
---*/
assert.sameValue(("a𝒜b".codePointAt(1)), 119964);
