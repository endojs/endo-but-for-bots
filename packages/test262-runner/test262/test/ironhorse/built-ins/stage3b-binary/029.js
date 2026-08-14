/*---
description: stage3b-binary corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 29.
  Source: typeof new Uint8Array(4)
---*/
assert.sameValue((typeof new Uint8Array(4)), "object");
