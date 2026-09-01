/*---
description: stage3-arrays corpus line 278 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-arrays.js line 278.
  Source: ["a","b","c"].toString()
---*/
assert.sameValue((["a","b","c"].toString()), "a,b,c");
