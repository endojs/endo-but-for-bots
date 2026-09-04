/*---
description: stage3b-regexp corpus line 27 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-regexp.js line 27.
  Source: /abc/.exec("xyz")
---*/
assert.sameValue((/abc/.exec("xyz")), null);
