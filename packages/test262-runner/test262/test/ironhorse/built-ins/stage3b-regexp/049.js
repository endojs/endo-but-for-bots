/*---
description: stage3b-regexp corpus line 49 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 49.
  Source: /\bword\b/.test("a word here")
---*/
assert.sameValue((/\bword\b/.test("a word here")), true);
