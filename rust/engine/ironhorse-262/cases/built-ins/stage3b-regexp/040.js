/*---
description: stage3b-regexp corpus line 40 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 40.
  Source: /^a/.test("abc")
---*/
assert.sameValue((/^a/.test("abc")), true);
