/*---
description: stage3-fundamentals corpus line 126 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 126.
  Source: (new TypeError('t')).toString()
---*/
assert.sameValue(((new TypeError('t')).toString()), "TypeError: t");
