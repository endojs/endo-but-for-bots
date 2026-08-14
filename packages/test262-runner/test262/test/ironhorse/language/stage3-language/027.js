/*---
description: stage3-language corpus line 27 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-language.js line 27.
  Source: typeof ("a" + "b")
---*/
assert.sameValue((typeof ("a" + "b")), "string");
