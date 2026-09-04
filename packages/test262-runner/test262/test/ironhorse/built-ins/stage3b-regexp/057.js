/*---
description: stage3b-regexp corpus line 57 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 57.
  Source: "abc123".search(/[0-9]/)
---*/
assert.sameValue(("abc123".search(/[0-9]/)), 3);
