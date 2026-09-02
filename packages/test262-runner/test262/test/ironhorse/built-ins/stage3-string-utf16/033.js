/*---
description: stage3-string-utf16 corpus line 33 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 33.
  Source: "a𝒜b".substring(1, 2).charCodeAt(0)
---*/
assert.sameValue(("a𝒜b".substring(1, 2).charCodeAt(0)), 55349);
