/*---
description: stage3-string-utf16 corpus line 53 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 53.
  Source: "A\uD800B"[2] === "B"
---*/
assert.sameValue(("A\uD800B"[2] === "B"), true);
