/*---
description: stage3-string-utf16 corpus line 24 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage3-string-utf16.js line 24.
  Source: var s2 = "xxxxxxxxxx𝒜yyyyyyyyyy"; var c2 = 0; for (var i = 0; i < s2.length; i++) { if (s2.charCodeAt(i) >= 0xD800) { c2++; } } c2
---*/
var s2 = "xxxxxxxxxx𝒜yyyyyyyyyy"; var c2 = 0; for (var i = 0; i < s2.length; i++) { if (s2.charCodeAt(i) >= 0xD800) { c2++; } } c2
