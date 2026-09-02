/*---
description: stage3b-binary corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 20.
  Source: new Uint8ClampedArray(8).length
---*/
assert.sameValue((new Uint8ClampedArray(8).length), 8);
