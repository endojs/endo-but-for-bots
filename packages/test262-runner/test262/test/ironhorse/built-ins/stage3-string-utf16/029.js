/*---
description: stage3-string-utf16 corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 29.
  Source: "a𝒜b".slice(1, 2).charCodeAt(0)
---*/
assert.sameValue(("a𝒜b".slice(1, 2).charCodeAt(0)), 55349);
