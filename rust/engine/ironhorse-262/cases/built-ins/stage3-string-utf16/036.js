/*---
description: stage3-string-utf16 corpus line 36 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 36.
  Source: "a𝒜b".slice(2, 3).charCodeAt(0) === 0xDC9C
---*/
assert.sameValue(("a𝒜b".slice(2, 3).charCodeAt(0) === 0xDC9C), true);
