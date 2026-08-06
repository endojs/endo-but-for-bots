/*---
description: stage3-string-utf16 corpus line 11 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 11.
  Source: "a𝒜b".codePointAt(0)
---*/
assert.sameValue(("a𝒜b".codePointAt(0)), 97);
