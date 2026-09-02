/*---
description: stage3-string-utf16 corpus line 18 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 18.
  Source: "a𝒜b".charCodeAt(2) === 0xDC9C
---*/
assert.sameValue(("a𝒜b".charCodeAt(2) === 0xDC9C), true);
