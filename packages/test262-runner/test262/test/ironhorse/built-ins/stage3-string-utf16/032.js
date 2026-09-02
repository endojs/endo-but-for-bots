/*---
description: stage3-string-utf16 corpus line 32 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 32.
  Source: "a𝒜b".slice(1, 3).codePointAt(0)
---*/
assert.sameValue(("a𝒜b".slice(1, 3).codePointAt(0)), 119964);
