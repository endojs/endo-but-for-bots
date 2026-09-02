/*---
description: stage3b-binary corpus line 27 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 27.
  Source: new Uint8Array().length
---*/
assert.sameValue((new Uint8Array().length), 0);
