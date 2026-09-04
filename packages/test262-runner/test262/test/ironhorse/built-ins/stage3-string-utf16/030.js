/*---
description: stage3-string-utf16 corpus line 30 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 30.
  Source: "a𝒜b".slice(2, 3).charCodeAt(0)
---*/
assert.sameValue(("a𝒜b".slice(2, 3).charCodeAt(0)), 56476);
