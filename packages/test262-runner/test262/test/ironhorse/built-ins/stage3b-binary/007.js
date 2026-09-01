/*---
description: stage3b-binary corpus line 7 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 7.
  Source: new ArrayBuffer(64).byteLength
---*/
assert.sameValue((new ArrayBuffer(64).byteLength), 64);
