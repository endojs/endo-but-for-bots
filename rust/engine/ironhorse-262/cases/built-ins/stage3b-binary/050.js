/*---
description: stage3b-binary corpus line 50 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-binary.js line 50.
  Source: ArrayBuffer.isView(new Uint8Array(4))
---*/
assert.sameValue((ArrayBuffer.isView(new Uint8Array(4))), true);
