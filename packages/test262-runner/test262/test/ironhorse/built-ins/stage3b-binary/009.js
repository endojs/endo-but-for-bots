/*---
description: stage3b-binary corpus line 9 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 9.
  Source: new ArrayBuffer(256).byteLength
---*/
assert.sameValue((new ArrayBuffer(256).byteLength), 256);
