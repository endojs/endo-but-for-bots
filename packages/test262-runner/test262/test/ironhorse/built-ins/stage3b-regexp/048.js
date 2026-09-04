/*---
description: stage3b-regexp corpus line 48 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 48.
  Source: /colou?r/.test("colour")
---*/
assert.sameValue((/colou?r/.test("colour")), true);
