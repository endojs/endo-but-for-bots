/*---
description: stage3-string-utf16 corpus line 37 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 37.
  Source: [..."a𝒜b"].length
---*/
assert.sameValue(([..."a𝒜b"].length), 3);
