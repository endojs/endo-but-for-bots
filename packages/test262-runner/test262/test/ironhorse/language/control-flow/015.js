/*---
description: control-flow corpus line 15 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 15.
  Source: 2 * (3 > 2 ? 4 : 5)
---*/
assert.sameValue((2 * (3 > 2 ? 4 : 5)), 8);
