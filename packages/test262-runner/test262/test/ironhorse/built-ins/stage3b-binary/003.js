/*---
description: stage3b-binary corpus line 3 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 3.
  Source: new ArrayBuffer(5).byteLength
---*/
assert.sameValue((new ArrayBuffer(5).byteLength), 5);
