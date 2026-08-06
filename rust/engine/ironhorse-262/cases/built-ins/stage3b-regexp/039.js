/*---
description: stage3b-regexp corpus line 39 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 39.
  Source: /abc/.test("xyz")
---*/
assert.sameValue((/abc/.test("xyz")), false);
