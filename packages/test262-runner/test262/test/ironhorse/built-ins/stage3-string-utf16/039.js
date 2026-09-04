/*---
description: stage3-string-utf16 corpus line 39 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 39.
  Source: [..."a𝒜b"][1].codePointAt(0)
---*/
assert.sameValue(([..."a𝒜b"][1].codePointAt(0)), 119964);
