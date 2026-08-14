/*---
description: control-flow corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 14.
  Source: (1 > 2 || 2 > 1) ? 7 : 8
---*/
assert.sameValue(((1 > 2 || 2 > 1) ? 7 : 8), 7);
