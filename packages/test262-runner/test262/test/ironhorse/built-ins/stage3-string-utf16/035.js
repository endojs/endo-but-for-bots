/*---
description: stage3-string-utf16 corpus line 35 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 35.
  Source: "a𝒜b".slice(1, 2).charCodeAt(0) === 0xD835
---*/
assert.sameValue(("a𝒜b".slice(1, 2).charCodeAt(0) === 0xD835), true);
