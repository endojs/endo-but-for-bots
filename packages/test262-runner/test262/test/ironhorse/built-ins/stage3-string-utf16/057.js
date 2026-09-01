/*---
description: stage3-string-utf16 corpus line 57 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 57.
  Source: ("A" + "\uD800" + "B").length
---*/
assert.sameValue((("A" + "\uD800" + "B").length), 3);
