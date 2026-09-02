/*---
description: stage3b-regexp corpus line 41 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 41.
  Source: /c$/.test("abc")
---*/
assert.sameValue((/c$/.test("abc")), true);
