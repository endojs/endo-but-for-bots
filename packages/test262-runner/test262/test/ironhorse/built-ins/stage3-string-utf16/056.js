/*---
description: stage3-string-utf16 corpus line 56 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 56.
  Source: ("\uD834" + "\uDD1E").codePointAt(0)
---*/
assert.sameValue((("\uD834" + "\uDD1E").codePointAt(0)), 119070);
