/*---
description: stage3b-binary corpus line 4 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 4.
  Source: new ArrayBuffer(8).byteLength
---*/
assert.sameValue((new ArrayBuffer(8).byteLength), 8);
