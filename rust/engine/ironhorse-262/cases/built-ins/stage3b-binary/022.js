/*---
description: stage3b-binary corpus line 22 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 22.
  Source: new Uint16Array(4).byteLength
---*/
assert.sameValue((new Uint16Array(4).byteLength), 8);
