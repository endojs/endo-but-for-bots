/*---
description: stage3-string-utf16 corpus line 27 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 27.
  Source: var s5 = "a".repeat(50) + "𝒜" + "b".repeat(50); s5.charCodeAt(50) === 0xD835
---*/
var s5 = "a".repeat(50) + "𝒜" + "b".repeat(50); s5.charCodeAt(50) === 0xD835
