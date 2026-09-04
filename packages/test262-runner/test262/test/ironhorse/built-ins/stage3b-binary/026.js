/*---
description: stage3b-binary corpus line 26 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 26.
  Source: new Float64Array(2).byteLength
---*/
assert.sameValue((new Float64Array(2).byteLength), 16);
