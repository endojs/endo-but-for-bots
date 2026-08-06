/*---
description: stage3-string-utf16 corpus line 21 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 21.
  Source: "a𝒜b"[4] === undefined
---*/
assert.sameValue(("a𝒜b"[4] === undefined), true);
