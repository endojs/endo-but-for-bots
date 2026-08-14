/*---
description: stage3b-regexp corpus line 42 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 42.
  Source: /[0-9]/.test("num=42")
---*/
assert.sameValue((/[0-9]/.test("num=42")), true);
