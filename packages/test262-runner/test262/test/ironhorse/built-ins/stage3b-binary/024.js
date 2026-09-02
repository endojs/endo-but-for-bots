/*---
description: stage3b-binary corpus line 24 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 24.
  Source: new Uint32Array(4).length
---*/
assert.sameValue((new Uint32Array(4).length), 4);
