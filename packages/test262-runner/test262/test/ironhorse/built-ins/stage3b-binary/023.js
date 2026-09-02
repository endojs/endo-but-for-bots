/*---
description: stage3b-binary corpus line 23 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 23.
  Source: new Int32Array(4).byteLength
---*/
assert.sameValue((new Int32Array(4).byteLength), 16);
