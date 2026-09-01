/*---
description: stage3-string-utf16 corpus line 52 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 52.
  Source: "A\uD800B".charCodeAt(1)
---*/
assert.sameValue(("A\uD800B".charCodeAt(1)), 55296);
