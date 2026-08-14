/*---
description: stage3-string-utf16 corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 14.
  Source: "a𝒜b".codePointAt(3)
---*/
assert.sameValue(("a𝒜b".codePointAt(3)), 98);
