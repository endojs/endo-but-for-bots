/*---
description: stage3-fundamentals corpus line 92 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 92.
  Source: (new RangeError('r')) instanceof RangeError
---*/
assert.sameValue(((new RangeError('r')) instanceof RangeError), true);
