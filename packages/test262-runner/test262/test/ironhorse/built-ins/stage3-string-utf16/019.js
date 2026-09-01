/*---
description: stage3-string-utf16 corpus line 19 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 19.
  Source: "a𝒜b"[0] === "a"
---*/
assert.sameValue(("a𝒜b"[0] === "a"), true);
