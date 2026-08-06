/*---
description: logic corpus line 19 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/logic.js line 19.
  Source: 1 < 2 === true
---*/
assert.sameValue((1 < 2 === true), true);
