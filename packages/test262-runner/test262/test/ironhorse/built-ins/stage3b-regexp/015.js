/*---
description: stage3b-regexp corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 15.
  Source: /a(b)c/gi.toString()
---*/
assert.sameValue((/a(b)c/gi.toString()), "/a(b)c/gi");
