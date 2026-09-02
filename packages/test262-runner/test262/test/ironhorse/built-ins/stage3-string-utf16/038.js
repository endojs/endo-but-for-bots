/*---
description: stage3-string-utf16 corpus line 38 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 38.
  Source: [..."a𝒜b"][1].length
---*/
assert.sameValue(([..."a𝒜b"][1].length), 2);
