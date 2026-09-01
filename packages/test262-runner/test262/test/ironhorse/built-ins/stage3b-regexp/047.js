/*---
description: stage3b-regexp corpus line 47 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 47.
  Source: /colou?r/.test("color")
---*/
assert.sameValue((/colou?r/.test("color")), true);
