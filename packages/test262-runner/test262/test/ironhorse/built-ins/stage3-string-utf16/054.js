/*---
description: stage3-string-utf16 corpus line 54 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 54.
  Source: "A\uD800B".codePointAt(1)
---*/
assert.sameValue(("A\uD800B".codePointAt(1)), 55296);
