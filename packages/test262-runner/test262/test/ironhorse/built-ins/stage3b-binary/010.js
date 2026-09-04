/*---
description: stage3b-binary corpus line 10 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 10.
  Source: new ArrayBuffer(1024).byteLength
---*/
assert.sameValue((new ArrayBuffer(1024).byteLength), 1024);
