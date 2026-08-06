/*---
description: stage3-string-utf16 corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 20.
  Source: "a𝒜b"[3] === "b"
---*/
assert.sameValue(("a𝒜b"[3] === "b"), true);
