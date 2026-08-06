/*---
description: stage3-string corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-string.js line 13.
  Source: "hello".codePointAt(1)
---*/
assert.sameValue(("hello".codePointAt(1)), 101);
