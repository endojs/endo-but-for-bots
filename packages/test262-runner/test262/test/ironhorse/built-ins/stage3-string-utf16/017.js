/*---
description: stage3-string-utf16 corpus line 17 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 17.
  Source: "a𝒜b".charCodeAt(1) === 0xD835
---*/
assert.sameValue(("a𝒜b".charCodeAt(1) === 0xD835), true);
