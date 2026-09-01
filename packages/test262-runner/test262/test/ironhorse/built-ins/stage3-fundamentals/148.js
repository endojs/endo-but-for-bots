/*---
description: stage3-fundamentals corpus line 148 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 148.
  Source: Symbol.iterator === Symbol.asyncIterator
---*/
assert.sameValue((Symbol.iterator === Symbol.asyncIterator), false);
