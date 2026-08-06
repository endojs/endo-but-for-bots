/*---
description: stage3b-binary corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 14.
  Source: typeof new ArrayBuffer(4)
---*/
assert.sameValue((typeof new ArrayBuffer(4)), "object");
