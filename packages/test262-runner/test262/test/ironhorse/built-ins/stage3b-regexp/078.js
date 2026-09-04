/*---
description: stage3b-regexp corpus line 78 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 78.
  Source: "a,b,c".split(/,/).length
---*/
assert.sameValue(("a,b,c".split(/,/).length), 3);
