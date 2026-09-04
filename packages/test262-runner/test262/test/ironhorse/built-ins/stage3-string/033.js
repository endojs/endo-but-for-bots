/*---
description: stage3-string corpus line 33 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 33.
  Source: "ab".concat("cd", "ef")
---*/
assert.sameValue(("ab".concat("cd", "ef")), "abcdef");
