/*---
description: stage3-string-utf16 corpus line 59 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 59.
  Source: "\uD800\uD801".charCodeAt(0)
---*/
assert.sameValue(("\uD800\uD801".charCodeAt(0)), 55296);
