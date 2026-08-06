/*---
description: stage3b-binary corpus line 5 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 5.
  Source: new ArrayBuffer(9).byteLength
---*/
assert.sameValue((new ArrayBuffer(9).byteLength), 9);
