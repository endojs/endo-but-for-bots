/*---
description: stage3-string-utf16 corpus line 58 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 58.
  Source: ("A" + "\uD800" + "B").charCodeAt(1)
---*/
assert.sameValue((("A" + "\uD800" + "B").charCodeAt(1)), 55296);
