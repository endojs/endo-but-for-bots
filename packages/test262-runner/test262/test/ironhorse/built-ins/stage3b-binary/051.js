/*---
description: stage3b-binary corpus line 51 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 51.
  Source: ArrayBuffer.isView(new ArrayBuffer(4))
---*/
assert.sameValue((ArrayBuffer.isView(new ArrayBuffer(4))), false);
