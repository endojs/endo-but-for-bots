/*---
description: stage3-string-utf16 corpus line 60 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 60.
  Source: "\uD800\uD801".codePointAt(0)
---*/
assert.sameValue(("\uD800\uD801".codePointAt(0)), 55296);
