/*---
description: control-flow corpus line 5 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 5.
  Source: 1 < 2 ? 3 < 4 ? 5 : 6 : 7
---*/
assert.sameValue((1 < 2 ? 3 < 4 ? 5 : 6 : 7), 5);
