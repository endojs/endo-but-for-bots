/*---
description: stage3b-binary corpus line 8 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 8.
  Source: new ArrayBuffer(255).byteLength
---*/
assert.sameValue((new ArrayBuffer(255).byteLength), 255);
