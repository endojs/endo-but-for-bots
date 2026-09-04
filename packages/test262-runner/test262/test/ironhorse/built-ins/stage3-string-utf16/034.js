/*---
description: stage3-string-utf16 corpus line 34 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 34.
  Source: "a𝒜b".substring(2, 3).charCodeAt(0)
---*/
assert.sameValue(("a𝒜b".substring(2, 3).charCodeAt(0)), 56476);
