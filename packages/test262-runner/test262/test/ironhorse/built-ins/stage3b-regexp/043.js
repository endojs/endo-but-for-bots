/*---
description: stage3b-regexp corpus line 43 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 43.
  Source: /xyz/.test("abcdefghij")
---*/
assert.sameValue((/xyz/.test("abcdefghij")), false);
