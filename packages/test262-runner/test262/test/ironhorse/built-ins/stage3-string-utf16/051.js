/*---
description: stage3-string-utf16 corpus line 51 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 51.
  Source: "A\uD800B".length
---*/
assert.sameValue(("A\uD800B".length), 3);
